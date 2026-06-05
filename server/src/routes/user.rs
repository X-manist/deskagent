use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::{issue_user_token, AuthUser};
use crate::error::{AppError, AppResult};
use crate::sms;
use crate::state::AppState;

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
            (id, false)
        }
        None => {
            let id: i64 = sqlx::query_scalar(
                "INSERT INTO users (phone, last_login_at) VALUES (?, datetime('now')) RETURNING id",
            )
            .bind(&phone)
            .fetch_one(&st.db)
            .await?;
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
    let (phone, free_used): (String, i64) =
        sqlx::query_as("SELECT phone, free_turns_used FROM users WHERE id = ?")
            .bind(uid)
            .fetch_one(&st.db)
            .await?;

    let ents: Vec<(String, i64, f64, i64, String)> = sqlx::query_as(
        "SELECT model, token_allowance, token_multiplier, tokens_used, expires_at FROM entitlements
         WHERE user_id = ? AND status='active' AND expires_at > datetime('now')
         ORDER BY expires_at ASC",
    )
    .bind(uid)
    .fetch_all(&st.db)
    .await?;

    let entitlements: Vec<serde_json::Value> = ents
        .into_iter()
        .map(|(model, allow, multiplier, used, exp)| {
            json!({
                "model": model,
                "token_allowance": allow,
                "points": allow,
                "token_multiplier": multiplier,
                "tokens_used": used,
                "tokens_remaining": (allow - used).max(0),
                "expires_at": exp,
            })
        })
        .collect();

    let free_remaining = (st.cfg.free_turns - free_used).max(0);
    Ok(json!({
        "id": uid,
        "phone": phone,
        "free_turns_total": st.cfg.free_turns,
        "free_turns_used": free_used,
        "free_turns_remaining": free_remaining,
        "entitlements": entitlements,
    }))
}

async fn me(State(st): State<AppState>, user: AuthUser) -> AppResult<Json<serde_json::Value>> {
    let payload = me_payload(&st, user.0.sub).await?;
    Ok(Json(payload))
}

async fn models(State(st): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(json!({
        "models": st.cfg.public_models(),
        "default_model": st.cfg.default_model,
    })))
}

async fn packages(State(st): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(i64, String, String, i64, f64, i64, i64)> = sqlx::query_as(
        "SELECT id, name, model, total_tokens, token_multiplier, price_cents, duration_days FROM packages
         WHERE active = 1 ORDER BY sort_order ASC, id ASC",
    )
    .fetch_all(&st.db)
    .await?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, name, model, tokens, multiplier, price, days)| {
            json!({
                "id": id, "name": name, "model": model,
                "total_tokens": tokens, "points": tokens, "token_allowance": tokens,
                "token_multiplier": multiplier, "price_cents": price,
                "price_yuan": format!("{:.2}", price as f64 / 100.0),
                "duration_days": days,
            })
        })
        .collect();
    Ok(Json(json!({ "packages": list })))
}
