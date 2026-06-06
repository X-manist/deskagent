use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth::AuthUser;
use crate::db;
use crate::error::{AppError, AppResult};
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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/orders", post(create_order))
        .route("/api/orders/{out_trade_no}/confirm", post(confirm_manual))
        // Payment provider webhooks (signature verification is provider-specific).
        .route("/pay/alipay/notify", post(alipay_notify))
        .route("/pay/wechat/notify", post(wechat_notify))
}

#[derive(Deserialize)]
struct CreateReq {
    package_id: i64,
    #[serde(default = "default_provider")]
    provider: String,
}
fn default_provider() -> String {
    "wechat".into()
}

async fn create_order(
    State(st): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateReq>,
) -> AppResult<Json<serde_json::Value>> {
    if !matches!(req.provider.as_str(), "manual" | "alipay" | "wechat") {
        return Err(AppError::bad("不支持的支付方式"));
    }
    if req.provider == "manual" && !st.cfg.allow_manual_pay {
        return Err(AppError::new(
            axum::http::StatusCode::FORBIDDEN,
            "manual_pay_disabled",
            "手动支付已关闭",
        ));
    }
    let pkg: Option<(String, String, i64, String, i64, i64)> = sqlx::query_as(
        "SELECT name, model, CASE WHEN points > 0 THEN points ELSE total_tokens END, models_json, price_cents, duration_days FROM packages WHERE id = ? AND active = 1",
    )
    .bind(req.package_id)
    .fetch_optional(&st.db)
    .await?;
    let (name, model, points, models_json, price, days) =
        pkg.ok_or_else(|| AppError::bad("套餐不存在或已下架"))?;
    let models = parse_models_json(&models_json, &model);
    let primary_model = models.first().cloned().unwrap_or_else(|| model.clone());
    let models_json =
        serde_json::to_string(&models).unwrap_or_else(|_| format!("[\"{}\"]", primary_model));

    let out_trade_no = crate::crypto::out_trade_no();
    sqlx::query(
        "INSERT INTO orders (out_trade_no, user_id, package_id, pkg_name, pkg_model, pkg_tokens, pkg_token_multiplier, pkg_points, pkg_models_json, pkg_days, amount_cents, provider, status)
         VALUES (?,?,?,?,?,?,1.0,?,?,?,?,?, 'pending_payment')",
    )
    .bind(&out_trade_no)
    .bind(user.0.sub)
    .bind(req.package_id)
    .bind(&name)
    .bind(&primary_model)
    .bind(points)
    .bind(points)
    .bind(&models_json)
    .bind(days)
    .bind(price)
    .bind(&req.provider)
    .execute(&st.db)
    .await?;

    // For real providers, here we'd call their unified-order API to get a pay_url/qr.
    let pay_info = match req.provider.as_str() {
        "manual" => json!({ "type": "manual", "note": "调用 confirm 接口模拟支付成功（测试用）" }),
        other => json!({ "type": other, "pay_url": null, "note": "需配置商户凭证后生成支付链接" }),
    };

    Ok(Json(json!({
        "out_trade_no": out_trade_no,
        "amount_cents": price,
        "amount_yuan": format!("{:.2}", price as f64 / 100.0),
        "provider": req.provider,
        "pay_info": pay_info,
    })))
}

/// Idempotently grant entitlement for a paid order. Safe under duplicate calls.
/// The status transition and entitlement insert happen in one transaction so an
/// order can never be marked 'granted' without its entitlement being created.
pub async fn grant_order(
    st: &AppState,
    out_trade_no: &str,
    provider_txn: Option<&str>,
) -> AppResult<bool> {
    let mut tx = st.db.begin().await?;

    // Atomically transition to 'granted'; only the first caller proceeds.
    let res = sqlx::query(
        "UPDATE orders SET status='granted', paid_at=COALESCE(paid_at, datetime('now')),
            granted_at=datetime('now'), provider_txn=COALESCE(?, provider_txn)
         WHERE out_trade_no = ? AND status != 'granted'",
    )
    .bind(provider_txn)
    .bind(out_trade_no)
    .execute(&mut *tx)
    .await?;
    if res.rows_affected() != 1 {
        return Ok(false); // already granted (or missing) — idempotent no-op
    }

    let order: (i64, String, i64, String, i64) = sqlx::query_as(
        "SELECT user_id, pkg_model, CASE WHEN pkg_points > 0 THEN pkg_points ELSE pkg_tokens END, pkg_models_json, pkg_days FROM orders WHERE out_trade_no = ?",
    )
    .bind(out_trade_no)
    .fetch_one(&mut *tx)
    .await?;
    let (user_id, model, points, models_json, days) = order;
    let models = parse_models_json(&models_json, &model);
    let primary_model = models.first().cloned().unwrap_or_else(|| model.clone());
    let models_json =
        serde_json::to_string(&models).unwrap_or_else(|_| format!("[\"{}\"]", primary_model));

    sqlx::query(
        "INSERT INTO entitlements (user_id, order_id, model, token_allowance, token_multiplier, points, models_json, expires_at, status)
         VALUES (?, (SELECT id FROM orders WHERE out_trade_no = ?), ?, ?, 1.0, ?, ?, datetime('now', ?), 'active')",
    )
    .bind(user_id)
    .bind(out_trade_no)
    .bind(&primary_model)
    .bind(points)
    .bind(points)
    .bind(&models_json)
    .bind(format!("+{days} days"))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    db::audit(
        &st.db,
        "system",
        "grant_order",
        &format!(
            "{out_trade_no} -> user {user_id} {points} points [{}]/{days}d",
            models.join(", ")
        ),
    )
    .await;
    Ok(true)
}

async fn confirm_manual(
    State(st): State<AppState>,
    user: AuthUser,
    Path(out_trade_no): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let owner: Option<(i64, String)> =
        sqlx::query_as("SELECT user_id, provider FROM orders WHERE out_trade_no = ?")
            .bind(&out_trade_no)
            .fetch_optional(&st.db)
            .await?;
    let (uid, provider) = owner.ok_or_else(|| AppError::bad("订单不存在"))?;
    if uid != user.0.sub {
        return Err(AppError::unauthorized("无权操作该订单"));
    }
    if provider != "manual" {
        return Err(AppError::bad("该订单不支持手动确认"));
    }
    if !st.cfg.allow_manual_pay {
        return Err(AppError::new(
            axum::http::StatusCode::FORBIDDEN,
            "manual_pay_disabled",
            "手动支付已关闭",
        ));
    }
    let granted = grant_order(&st, &out_trade_no, Some("manual-confirm")).await?;
    Ok(Json(json!({ "ok": true, "granted": granted })))
}

// --- Payment webhooks (scaffolds; signature verification requires merchant creds) ---

async fn alipay_notify(State(_st): State<AppState>, body: String) -> AppResult<String> {
    tracing::warn!(
        "alipay notify received but verification not configured: {} bytes",
        body.len()
    );
    // TODO: verify RSA2 sign, match out_trade_no + total_amount, then grant_order.
    Err(AppError::new(
        axum::http::StatusCode::NOT_IMPLEMENTED,
        "not_configured",
        "支付宝支付暂未配置商户凭证",
    ))
}

async fn wechat_notify(State(_st): State<AppState>, body: String) -> AppResult<String> {
    tracing::warn!(
        "wechat notify received but verification not configured: {} bytes",
        body.len()
    );
    // TODO: verify v3 signature, decrypt resource, match amount, then grant_order.
    Err(AppError::new(
        axum::http::StatusCode::NOT_IMPLEMENTED,
        "not_configured",
        "微信支付暂未配置商户凭证",
    ))
}
