use axum::extract::{Path, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth::{issue_admin_token, issue_user_token, AuthAdmin};
use crate::crypto;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/api/login", post(login))
        .route("/admin/api/stats", get(stats))
        .route("/admin/api/users", get(list_users))
        .route("/admin/api/test-users", post(create_test_user))
        .route("/admin/api/orders", get(list_orders))
        .route(
            "/admin/api/packages",
            get(list_packages).post(create_package),
        )
        .route("/admin/api/packages/{id}", put(update_package))
        .route("/admin/api/audit", get(list_audit))
}

#[derive(Deserialize)]
struct LoginReq {
    username: String,
    password: String,
}

async fn login(
    State(st): State<AppState>,
    Json(req): Json<LoginReq>,
) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(i64, String, i64)> =
        sqlx::query_as("SELECT id, password_hash, token_version FROM admins WHERE username = ?")
            .bind(&req.username)
            .fetch_optional(&st.db)
            .await?;
    let (id, hash, tv) = row.ok_or_else(|| AppError::unauthorized("账号或密码错误"))?;
    if !crypto::verify_password(&req.password, &hash) {
        return Err(AppError::unauthorized("账号或密码错误"));
    }
    let token = issue_admin_token(&st.cfg.admin_jwt_secret, id, &req.username, tv);
    Ok(Json(json!({ "token": token, "username": req.username })))
}

async fn stats(State(st): State<AppState>, _a: AuthAdmin) -> AppResult<Json<serde_json::Value>> {
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&st.db)
        .await?;
    let new_today: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE date(created_at) = date('now')")
            .fetch_one(&st.db)
            .await?;
    let paid_orders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM orders WHERE status='granted'")
        .fetch_one(&st.db)
        .await?;
    let revenue_cents: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE status='granted'",
    )
    .fetch_one(&st.db)
    .await?;
    let total_turns: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usage_sessions")
        .fetch_one(&st.db)
        .await?;
    let total_tokens: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(total_tokens),0) FROM usage_sessions")
            .fetch_one(&st.db)
            .await?;
    Ok(Json(json!({
        "users_total": users,
        "users_new_today": new_today,
        "orders_paid": paid_orders,
        "revenue_cents": revenue_cents,
        "revenue_yuan": format!("{:.2}", revenue_cents as f64 / 100.0),
        "turns_total": total_turns,
        "tokens_total": total_tokens,
    })))
}

async fn list_users(
    State(st): State<AppState>,
    _a: AuthAdmin,
) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(i64, String, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT id, phone, free_turns_used, created_at, last_login_at FROM users ORDER BY id DESC LIMIT 500",
    )
    .fetch_all(&st.db)
    .await?;
    let mut list = Vec::new();
    for (id, phone, free_used, created, last_login) in rows {
        let turns: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM usage_sessions WHERE user_id = ?")
                .bind(id)
                .fetch_one(&st.db)
                .await?;
        let tokens: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(total_tokens),0) FROM usage_sessions WHERE user_id = ?",
        )
        .bind(id)
        .fetch_one(&st.db)
        .await?;
        let points_remaining: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(token_allowance - tokens_used),0) FROM entitlements
             WHERE user_id = ? AND status='active' AND expires_at > datetime('now')",
        )
        .bind(id)
        .fetch_one(&st.db)
        .await?;
        let spent: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(amount_cents),0) FROM orders WHERE user_id = ? AND status='granted'",
        )
        .bind(id)
        .fetch_one(&st.db)
        .await?;
        list.push(json!({
            "id": id, "phone": phone,
            "free_turns_used": free_used,
            "free_turns_total": st.cfg.free_turns,
            "free_turns_remaining": (st.cfg.free_turns - free_used).max(0),
            "points_remaining": points_remaining.max(0),
            "tokens_remaining": points_remaining.max(0),
            "turns": turns, "tokens": tokens,
            "spent_cents": spent,
            "spent_yuan": format!("{:.2}", spent as f64 / 100.0),
            "created_at": created, "last_login_at": last_login,
        }));
    }
    Ok(Json(json!({ "users": list })))
}

#[derive(Deserialize)]
struct TestUserReq {
    phone: Option<String>,
    #[serde(default)]
    points: Option<i64>,
    #[serde(default)]
    token_allowance: Option<i64>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    duration_days: Option<i64>,
    #[serde(default = "default_multiplier")]
    token_multiplier: f64,
}

fn valid_phone(p: &str) -> bool {
    p.len() == 11 && p.starts_with('1') && p.chars().all(|c| c.is_ascii_digit())
}

async fn create_test_user(
    State(st): State<AppState>,
    a: AuthAdmin,
    Json(req): Json<TestUserReq>,
) -> AppResult<Json<serde_json::Value>> {
    let phone = req
        .phone
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| {
            let suffix = chrono::Utc::now().timestamp_millis().rem_euclid(100_000_000);
            format!("199{suffix:08}")
        });
    if !valid_phone(&phone) {
        return Err(AppError::bad("手机号格式不正确"));
    }
    let allowance = req.points.or(req.token_allowance).unwrap_or(0);
    if allowance < 0 {
        return Err(AppError::bad("测试积分不能为负数"));
    }
    if allowance > i64::from(i32::MAX) * 1_000_000 {
        return Err(AppError::bad("测试积分过大"));
    }
    let duration_days = req.duration_days.unwrap_or(30);
    if allowance > 0 && duration_days <= 0 {
        return Err(AppError::bad("测试积分有效天数必须大于 0"));
    }
    if !req.token_multiplier.is_finite() || req.token_multiplier <= 0.0 {
        return Err(AppError::bad("计费倍率必须大于 0"));
    }
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(st.cfg.default_model.as_str())
        .to_string();

    let mut tx = st.db.begin().await?;
    let (id, free_used): (i64, i64) = sqlx::query_as(
        "INSERT INTO users (phone, last_login_at)
         VALUES (?, datetime('now'))
         ON CONFLICT(phone) DO UPDATE SET last_login_at = datetime('now')
         RETURNING id, free_turns_used",
    )
    .bind(&phone)
    .fetch_one(&mut *tx)
    .await?;
    let replaces_test_allowance = req.points.is_some() || req.token_allowance.is_some();
    if replaces_test_allowance {
        sqlx::query(
            "UPDATE entitlements SET status='revoked'
             WHERE user_id = ? AND order_id IS NULL AND status='active'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    let entitlement = if allowance > 0 {
        let (entitlement_id, expires_at): (i64, String) = sqlx::query_as(
            "INSERT INTO entitlements (user_id, order_id, model, token_allowance, token_multiplier, expires_at, status)
             VALUES (?, NULL, ?, ?, ?, datetime('now', ?), 'active')
             RETURNING id, expires_at",
        )
        .bind(id)
        .bind(&model)
        .bind(allowance)
        .bind(req.token_multiplier)
        .bind(format!("+{duration_days} days"))
        .fetch_one(&mut *tx)
        .await?;
        Some(json!({
            "id": entitlement_id,
            "model": &model,
            "token_allowance": allowance,
            "points": allowance,
            "token_multiplier": req.token_multiplier,
            "tokens_used": 0,
            "tokens_remaining": allowance,
            "points_remaining": allowance,
            "duration_days": duration_days,
            "expires_at": expires_at,
        }))
    } else {
        None
    };
    tx.commit().await?;

    let token = issue_user_token(&st.cfg.user_jwt_secret, id, &phone);
    db::audit(
        &st.db,
        &a.0.username,
        "create_test_user",
        &format!(
            "user #{id} {phone}{}",
            if allowance > 0 {
                format!(" +{allowance} points {model} x{}/{}d", req.token_multiplier, duration_days)
            } else {
                String::new()
            }
        ),
    )
    .await;
    Ok(Json(json!({
        "ok": true,
        "user": {
            "id": id,
            "phone": phone,
            "free_turns_total": st.cfg.free_turns,
            "free_turns_used": free_used,
            "free_turns_remaining": (st.cfg.free_turns - free_used).max(0),
        },
        "entitlement": entitlement,
        "token": token,
    })))
}

async fn list_orders(
    State(st): State<AppState>,
    _a: AuthAdmin,
) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(String, i64, String, i64, String, String, String)> = sqlx::query_as(
        "SELECT out_trade_no, user_id, pkg_name, amount_cents, provider, status, created_at
         FROM orders ORDER BY id DESC LIMIT 500",
    )
    .fetch_all(&st.db)
    .await?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(no, uid, name, amount, provider, status, created)| {
            json!({
                "out_trade_no": no, "user_id": uid, "pkg_name": name,
                "amount_cents": amount, "amount_yuan": format!("{:.2}", amount as f64 / 100.0),
                "provider": provider, "status": status, "created_at": created,
            })
        })
        .collect();
    Ok(Json(json!({ "orders": list })))
}

async fn list_packages(
    State(st): State<AppState>,
    _a: AuthAdmin,
) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(i64, String, String, i64, f64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, name, model, total_tokens, token_multiplier, price_cents, duration_days, active, sort_order
         FROM packages ORDER BY sort_order ASC, id ASC",
    )
    .fetch_all(&st.db)
    .await?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(
            |(id, name, model, tokens, multiplier, price, days, active, sort)| {
                json!({
                    "id": id, "name": name, "model": model,
                    "total_tokens": tokens, "points": tokens, "token_allowance": tokens,
                    "token_multiplier": multiplier,
                    "price_cents": price, "price_yuan": format!("{:.2}", price as f64 / 100.0),
                    "duration_days": days,
                    "active": active == 1, "sort_order": sort,
                })
            },
        )
        .collect();
    Ok(Json(json!({ "packages": list })))
}

#[derive(Deserialize)]
struct PackageReq {
    name: String,
    model: String,
    total_tokens: i64,
    #[serde(default = "default_multiplier")]
    token_multiplier: f64,
    price_cents: i64,
    duration_days: i64,
    #[serde(default = "default_true")]
    active: bool,
    #[serde(default)]
    sort_order: i64,
}
fn default_true() -> bool {
    true
}
fn default_multiplier() -> f64 {
    1.0
}

fn validate_package(req: &PackageReq) -> AppResult<()> {
    if req.name.trim().is_empty() {
        return Err(AppError::bad("套餐名称不能为空"));
    }
    if req.model.trim().is_empty() {
        return Err(AppError::bad("模型不能为空"));
    }
    if req.total_tokens <= 0 {
        return Err(AppError::bad("套餐积分数必须大于 0"));
    }
    if req.price_cents < 0 {
        return Err(AppError::bad("套餐价格不能为负数"));
    }
    if req.duration_days <= 0 {
        return Err(AppError::bad("有效天数必须大于 0"));
    }
    if !req.token_multiplier.is_finite() || req.token_multiplier <= 0.0 {
        return Err(AppError::bad("计费倍率必须大于 0"));
    }
    Ok(())
}

async fn create_package(
    State(st): State<AppState>,
    a: AuthAdmin,
    Json(req): Json<PackageReq>,
) -> AppResult<Json<serde_json::Value>> {
    validate_package(&req)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO packages (name, model, total_tokens, token_multiplier, price_cents, duration_days, active, sort_order)
         VALUES (?,?,?,?,?,?,?,?) RETURNING id",
    )
    .bind(req.name.trim())
    .bind(req.model.trim())
    .bind(req.total_tokens)
    .bind(req.token_multiplier)
    .bind(req.price_cents)
    .bind(req.duration_days)
    .bind(req.active as i64)
    .bind(req.sort_order)
    .fetch_one(&st.db)
    .await?;
    db::audit(
        &st.db,
        &a.0.username,
        "create_package",
        &format!(
            "#{id} {} {} {} points x{}",
            req.name, req.model, req.total_tokens, req.token_multiplier
        ),
    )
    .await;
    Ok(Json(json!({ "ok": true, "id": id })))
}

async fn update_package(
    State(st): State<AppState>,
    a: AuthAdmin,
    Path(id): Path<i64>,
    Json(req): Json<PackageReq>,
) -> AppResult<Json<serde_json::Value>> {
    validate_package(&req)?;
    let res = sqlx::query(
        "UPDATE packages SET name=?, model=?, total_tokens=?, token_multiplier=?, price_cents=?, duration_days=?, active=?, sort_order=? WHERE id=?",
    )
    .bind(req.name.trim())
    .bind(req.model.trim())
    .bind(req.total_tokens)
    .bind(req.token_multiplier)
    .bind(req.price_cents)
    .bind(req.duration_days)
    .bind(req.active as i64)
    .bind(req.sort_order)
    .bind(id)
    .execute(&st.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::bad("套餐不存在"));
    }
    db::audit(
        &st.db,
        &a.0.username,
        "update_package",
        &format!(
            "#{id} {} {} {} points x{}",
            req.name, req.model, req.total_tokens, req.token_multiplier
        ),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

async fn list_audit(
    State(st): State<AppState>,
    _a: AuthAdmin,
) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(i64, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, actor, action, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT 200",
    )
    .fetch_all(&st.db)
    .await?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, actor, action, detail, created)| {
            json!({ "id": id, "actor": actor, "action": action, "detail": detail, "created_at": created })
        })
        .collect();
    Ok(Json(json!({ "audit": list })))
}
