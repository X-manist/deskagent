use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::{issue_user_token, AuthUser};
use crate::error::{AppError, AppResult};
use crate::meter;
use crate::models;
use crate::sms;
use crate::state::AppState;

fn parse_models_json(raw: &str, fallback: &str) -> Vec<String> {
    let mut models = serde_json::from_str::<Vec<String>>(raw)
        .unwrap_or_default()
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .collect::<Vec<_>>();
    if models.is_empty() && !fallback.trim().is_empty() {
        models.push(fallback.trim().to_string());
    }
    models.sort();
    models.dedup();
    models
}

async fn grant_free_points(st: &AppState, uid: i64) -> AppResult<()> {
    if st.cfg.free_points <= 0 {
        return Ok(());
    }
    let existing_free_grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM entitlements WHERE user_id = ? AND order_id IS NULL",
    )
    .bind(uid)
    .fetch_one(&st.db)
    .await?;
    if existing_free_grants > 0 {
        return Ok(());
    }
    let models = st
        .cfg
        .free_models
        .iter()
        .filter(|model| st.cfg.model(model).is_some())
        .cloned()
        .collect::<Vec<_>>();
    let models = if models.is_empty() {
        vec![st.cfg.default_model.clone()]
    } else {
        models
    };
    let primary = models
        .first()
        .cloned()
        .unwrap_or_else(|| st.cfg.default_model.clone());
    let models_json =
        serde_json::to_string(&models).unwrap_or_else(|_| format!("[\"{}\"]", primary));
    sqlx::query(
        "INSERT INTO entitlements (user_id, order_id, model, token_allowance, token_multiplier, points, models_json, expires_at, status)
         VALUES (?, NULL, ?, ?, 1.0, ?, ?, datetime('now', ?), 'active')",
    )
    .bind(uid)
    .bind(primary)
    .bind(st.cfg.free_points)
    .bind(st.cfg.free_points)
    .bind(models_json)
    .bind(format!("+{} days", st.cfg.free_points_duration_days))
    .execute(&st.db)
    .await?;
    Ok(())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/sms/send", post(sms_send))
        .route("/auth/sms/verify", post(sms_verify))
        .route("/api/me", get(me))
        .route("/api/models", get(models))
        .route("/api/packages", get(packages))
}

fn valid_phone(p: &str) -> bool {
    p.len() == 11 && p.starts_with('1') && p.chars().all(|c| c.is_ascii_digit())
}

#[derive(Deserialize)]
struct SendReq {
    phone: String,
}

async fn sms_send(
    State(st): State<AppState>,
    Json(req): Json<SendReq>,
) -> AppResult<Json<serde_json::Value>> {
    let phone = req.phone.trim().to_string();
    if !valid_phone(&phone) {
        return Err(AppError::bad("手机号格式不正确"));
    }

    // Anti-abuse: cooldown + lockout + windowed send count.
    let row: Option<(Option<String>, i64, Option<String>)> = sqlx::query_as(
        "SELECT last_sent_at, send_count, lockout_until FROM sms_throttle WHERE phone = ?",
    )
    .bind(&phone)
    .fetch_optional(&st.db)
    .await?;

    if let Some((last_sent, send_count, lockout)) = &row {
        if let Some(lk) = lockout {
            let locked: Option<i64> = sqlx::query_scalar("SELECT (datetime('now') < ?)")
                .bind(lk)
                .fetch_one(&st.db)
                .await?;
            if locked == Some(1) {
                return Err(AppError::rate_limited("操作过于频繁，请稍后再试"));
            }
        }
        if let Some(ls) = last_sent {
            let within: Option<i64> =
                sqlx::query_scalar("SELECT (strftime('%s','now') - strftime('%s', ?)) < ?")
                    .bind(ls)
                    .bind(st.cfg.sms_cooldown_secs)
                    .fetch_one(&st.db)
                    .await?;
            if within == Some(1) {
                return Err(AppError::rate_limited("验证码发送过于频繁，请稍后再试"));
            }
        }
        let _ = send_count;
    }

    let code = sms::send_code(&st.cfg, &st.http, &phone)
        .await
        .map_err(|e| AppError::internal(format!("短信发送失败: {e}")))?;

    sqlx::query(
        "INSERT INTO sms_throttle (phone, last_sent_at, send_count, window_start)
         VALUES (?, datetime('now'), 1, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET
           last_sent_at = datetime('now'),
           send_count = send_count + 1",
    )
    .bind(&phone)
    .execute(&st.db)
    .await?;

    let mut resp = json!({ "ok": true, "mock": st.cfg.is_mock_sms() });
    if st.cfg.is_mock_sms() && st.cfg.sms_expose_mock_code {
        resp["dev_code"] = json!(code);
    }
    Ok(Json(resp))
}

#[derive(Deserialize)]
struct VerifyReq {
    phone: String,
    code: String,
}

#[derive(Serialize)]
struct VerifyResp {
    token: String,
    user: serde_json::Value,
    is_new: bool,
}

async fn sms_verify(
    State(st): State<AppState>,
    Json(req): Json<VerifyReq>,
) -> AppResult<Json<VerifyResp>> {
    let phone = req.phone.trim().to_string();
    let code = req.code.trim().to_string();
    if !valid_phone(&phone) {
        return Err(AppError::bad("手机号格式不正确"));
    }
    if code.is_empty() {
        return Err(AppError::bad("请输入验证码"));
    }

    let ok = sms::check_code(&st.cfg, &st.http, &phone, &code)
        .await
        .map_err(|e| AppError::internal(format!("验证码校验失败: {e}")))?;
    if !ok {
        // Track failures for lockout.
        sqlx::query(
            "INSERT INTO sms_throttle (phone, fail_count) VALUES (?, 1)
             ON CONFLICT(phone) DO UPDATE SET fail_count = fail_count + 1,
               lockout_until = CASE WHEN fail_count + 1 >= 5 THEN datetime('now','+15 minutes') ELSE lockout_until END",
        )
        .bind(&phone)
        .execute(&st.db)
        .await?;
        return Err(AppError::unauthorized("验证码错误或已过期"));
    }

    // Reset failures.
    let _ =
        sqlx::query("UPDATE sms_throttle SET fail_count = 0, lockout_until = NULL WHERE phone = ?")
            .bind(&phone)
            .execute(&st.db)
            .await;

    // Find or create the user.
    let existing: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE phone = ?")
        .bind(&phone)
        .fetch_optional(&st.db)
        .await?;
    let (uid, is_new) = match existing {
        Some(id) => {
            sqlx::query("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
                .bind(id)
                .execute(&st.db)
                .await?;
            grant_free_points(&st, id).await?;
            (id, false)
        }
        None => {
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO users (phone, last_login_at) VALUES (?, datetime('now')) RETURNING id",
            )
            .bind(&phone)
            .fetch_one(&st.db)
            .await?;
            grant_free_points(&st, id).await?;
            (id, true)
        }
    };

    let token = issue_user_token(&st.cfg.user_jwt_secret, uid, &phone);
    let user = me_payload(&st, uid).await?;
    Ok(Json(VerifyResp {
        token,
        user,
        is_new,
    }))
}

async fn me_payload(st: &AppState, uid: i64) -> AppResult<serde_json::Value> {
    let phone: String = sqlx::query_scalar("SELECT phone FROM users WHERE id = ?")
        .bind(uid)
        .fetch_one(&st.db)
        .await?;

    let ents: Vec<(i64, String, i64, String, i64, String)> = sqlx::query_as(
        "SELECT id, model, CASE WHEN points > 0 THEN points ELSE token_allowance END, models_json, tokens_used, expires_at FROM entitlements
         WHERE user_id = ? AND status='active' AND expires_at > datetime('now')
         ORDER BY expires_at ASC",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;

    let mut allowed_models = Vec::<String>::new();
    let mut points_remaining_micros = 0i64;
    let entitlements: Vec<serde_json::Value> = ents
        .into_iter()
        .map(|(id, model, points, models_json, used, exp)| {
            let models = parse_models_json(&models_json, &model);
            let remaining_micros = meter::remaining_point_micros(points, used);
            let remaining_points = meter::display_points_from_micros(remaining_micros);
            let used_points = meter::display_used_points(used);
            if remaining_micros > 0 {
                points_remaining_micros =
                    points_remaining_micros.saturating_add(remaining_micros);
                allowed_models.extend(models.iter().cloned());
            }
            json!({
                "id": id,
                "model": model,
                "models": models,
                "token_allowance": points,
                "points": points,
                "tokens_used": used_points,
                "tokens_remaining": remaining_points,
                "points_used": used_points,
                "points_used_micros": used.max(0),
                "points_remaining": remaining_points,
                "expires_at": exp,
            })
        })
        .collect();
    allowed_models.sort();
    allowed_models.dedup();
    let allowed_models = allowed_models
        .into_iter()
        .filter_map(|id| st.cfg.model(&id))
        .collect::<Vec<_>>();
    let pricing = models::multiplier_overrides(&st.db).await?;
    let allowed_models = allowed_models
        .into_iter()
        .map(|mut model| {
            if let Some(multiplier) = pricing.get(&model.id).copied() {
                model.point_multiplier = multiplier;
            }
            json!({
                "id": model.id,
                "name": model.display_name,
                "display_name": model.display_name,
                "provider": model.provider,
                "configured": !model.api_key.trim().is_empty(),
                "point_multiplier": model.point_multiplier,
            })
        })
        .collect::<Vec<_>>();
    let points_remaining = meter::display_points_from_micros(points_remaining_micros);

    Ok(json!({
        "id": uid,
        "phone": phone,
        "points_remaining": points_remaining,
        "allowed_models": allowed_models,
        "entitlements": entitlements,
    }))
}

async fn me(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<serde_json::Value>> {
    let payload = me_payload(&st, user.0.sub).await?;
    Ok(Json(payload))
}

async fn models(State(st): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "models": models::public_models(&st.cfg, &st.db).await?,
        "default_model": st.cfg.default_model,
    })))
}

async fn packages(State(st): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(i64, String, String, i64, String, i64, i64)> = sqlx::query_as(
        "SELECT id, name, model, CASE WHEN points > 0 THEN points ELSE total_tokens END, models_json, price_cents, duration_days FROM packages
         WHERE active = 1 ORDER BY sort_order ASC, id ASC",
    )
    .fetch_all(&st.db)
    .await?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, name, model, points, models_json, price, days)| {
            let models = parse_models_json(&models_json, &model);
            json!({
                "id": id, "name": name, "model": model, "models": models,
                "total_tokens": points, "points": points, "token_allowance": points,
                "price_cents": price,
                "price_yuan": format!("{:.2}", price as f64 / 100.0),
                "duration_days": days,
            })
        })
        .collect();
    Ok(Json(json!({ "packages": list })))
}
