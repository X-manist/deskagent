use sqlx::SqlitePool;

use crate::crypto;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct Reservation {
    pub session_id: String,
    pub source: String, // 'free' | 'entitlement'
    pub entitlement_id: Option<i64>,
    pub model: String,
    pub reserved_points: i64,
    pub point_multiplier: f64,
}

fn charge_points(tokens: i64, multiplier: f64) -> i64 {
    if tokens <= 0 {
        return 0;
    }
    let safe_multiplier = if multiplier.is_finite() && multiplier > 0.0 {
        multiplier
    } else {
        1.0
    };
    ((tokens as f64) * safe_multiplier).ceil() as i64
}

/// Atomically reserve capacity for one request.
/// The quota mutation and the usage_sessions insert happen in one transaction
/// so a failure can never leave charged quota without a session to reconcile.
pub async fn reserve(
    db: &SqlitePool,
    user_id: i64,
    model: &str,
    reserve_tokens: i64,
    model_point_multiplier: f64,
) -> AppResult<Reservation> {
    let mut tx = db.begin().await?;

    // Try point entitlements (oldest-expiring first) with a conditional UPDATE.
    let candidates: Vec<i64> = sqlx::query_scalar(
        "SELECT id FROM entitlements
         WHERE user_id = ? AND status = 'active'
           AND expires_at > datetime('now')
           AND EXISTS (
             SELECT 1 FROM json_each(
               CASE
                 WHEN models_json IS NULL OR models_json = '' OR models_json = '[]' THEN json_array(model)
                 ELSE models_json
               END
             ) WHERE value = ?
           )
         ORDER BY expires_at ASC, id ASC",
    )
    .bind(user_id)
    .bind(model)
    .fetch_all(&mut *tx)
    .await?;

    for ent_id in candidates {
        let reserve_charge = charge_points(reserve_tokens, model_point_multiplier);
        let res = sqlx::query(
            "UPDATE entitlements SET tokens_used = tokens_used + ?
             WHERE id = ? AND status = 'active' AND expires_at > datetime('now')
               AND (CASE WHEN points > 0 THEN points ELSE token_allowance END) - tokens_used >= ?",
        )
        .bind(reserve_charge)
        .bind(ent_id)
        .bind(reserve_charge)
        .execute(&mut *tx)
        .await?;
        if res.rows_affected() == 1 {
            let sid = crypto::new_uuid();
            sqlx::query(
                "INSERT INTO usage_sessions (id, user_id, source, entitlement_id, model, reserved_tokens, status)
                 VALUES (?,?,'entitlement',?,?,?,'reserved')",
            )
            .bind(&sid)
            .bind(user_id)
            .bind(ent_id)
            .bind(model)
            .bind(reserve_charge)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(Reservation {
                session_id: sid,
                source: "entitlement".into(),
                entitlement_id: Some(ent_id),
                model: model.into(),
                reserved_points: reserve_charge,
                point_multiplier: model_point_multiplier,
            });
        }
    }

    Err(AppError::quota("积分不足或当前套餐不支持该模型，请切换模型或购买套餐后继续使用"))
}

/// Refund a reservation when the upstream definitively failed before producing
/// any billable work (connect error / non-2xx / unreadable body). Entitlement
/// reservations are returned.
pub async fn fail_reservation(db: &SqlitePool, r: &Reservation) {
    if let Some(ent_id) = r.entitlement_id {
        let _ = sqlx::query("UPDATE entitlements SET tokens_used = tokens_used - ? WHERE id = ?")
            .bind(r.reserved_points)
            .bind(ent_id)
            .execute(db)
            .await;
    }
    let _ = sqlx::query(
        "UPDATE usage_sessions SET total_tokens=0, status='failed', finished_at=datetime('now') WHERE id=?",
    )
    .bind(&r.session_id)
    .execute(db)
    .await;
}
/// `actual_total` = None means usage was not observed (stream failed / no usage event).
pub async fn reconcile(
    db: &SqlitePool,
    r: &Reservation,
    prompt: i64,
    completion: i64,
    actual_total: Option<i64>,
) {
    match actual_total {
        Some(total) => {
            let charged_total = charge_points(total, r.point_multiplier);
            if let Some(ent_id) = r.entitlement_id {
                let delta = charged_total - r.reserved_points;
                let _ = sqlx::query(
                    "UPDATE entitlements SET tokens_used = tokens_used + ? WHERE id = ?",
                )
                .bind(delta)
                .bind(ent_id)
                .execute(db)
                .await;
            }
            let _ = sqlx::query(
                "UPDATE usage_sessions SET prompt_tokens=?, completion_tokens=?, total_tokens=?, status='completed', finished_at=datetime('now') WHERE id=?",
            )
            .bind(prompt)
            .bind(completion)
            .bind(total)
            .bind(&r.session_id)
            .execute(db)
            .await;
        }
        None => {
            // Keep the reservation charge; flag for later inspection.
            let _ = sqlx::query(
                "UPDATE usage_sessions SET total_tokens=0, status='usage_unknown', finished_at=datetime('now') WHERE id=?",
            )
            .bind(&r.session_id)
            .execute(db)
            .await;
        }
    }
}
