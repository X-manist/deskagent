use sqlx::SqlitePool;

use crate::crypto;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone)]
pub struct Reservation {
    pub session_id: String,
    pub source: String, // 'free' | 'entitlement'
    pub entitlement_id: Option<i64>,
    pub model: String,
    pub reserved_tokens: i64,
    pub token_multiplier: f64,
}

fn charge_tokens(tokens: i64, multiplier: f64) -> i64 {
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
/// Order of preference: a matching paid entitlement, then a free turn.
/// The quota mutation and the usage_sessions insert happen in one transaction
/// so a failure can never leave charged quota without a session to reconcile.
pub async fn reserve(
    db: &SqlitePool,
    user_id: i64,
    model: &str,
    reserve_tokens: i64,
    free_cap: i64,
) -> AppResult<Reservation> {
    let mut tx = db.begin().await?;

    // 1) Try paid entitlements (oldest-expiring first) with a conditional UPDATE.
    let candidates: Vec<(i64, f64)> = sqlx::query_as(
        "SELECT id, token_multiplier FROM entitlements
         WHERE user_id = ? AND model = ? AND status = 'active'
           AND expires_at > datetime('now')
         ORDER BY expires_at ASC",
    )
    .bind(user_id)
    .bind(model)
    .fetch_all(&mut *tx)
    .await?;

    for (ent_id, multiplier) in candidates {
        let reserve_charge = charge_tokens(reserve_tokens, multiplier);
        let res = sqlx::query(
            "UPDATE entitlements SET tokens_used = tokens_used + ?
             WHERE id = ? AND status = 'active' AND expires_at > datetime('now')
               AND token_allowance - tokens_used >= ?",
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
                reserved_tokens: reserve_charge,
                token_multiplier: multiplier,
            });
        }
    }

    // 2) Fall back to a free turn (turn-based, not token-based).
    let res = sqlx::query("UPDATE users SET free_turns_used = free_turns_used + 1 WHERE id = ? AND free_turns_used < ?")
        .bind(user_id)
        .bind(free_cap)
        .execute(&mut *tx)
        .await?;
    if res.rows_affected() == 1 {
        let sid = crypto::new_uuid();
        sqlx::query(
            "INSERT INTO usage_sessions (id, user_id, source, model, reserved_tokens, status)
             VALUES (?,?,'free',?,0,'reserved')",
        )
        .bind(&sid)
        .bind(user_id)
        .bind(model)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Reservation {
            session_id: sid,
            source: "free".into(),
            entitlement_id: None,
            model: model.into(),
            reserved_tokens: 0,
            token_multiplier: 1.0,
        });
    }

    Err(AppError::quota("额度不足，请购买会员套餐后继续使用"))
}

/// Refund a reservation when the upstream definitively failed before producing
/// any billable work (connect error / non-2xx / unreadable body). Entitlement
/// reservations are returned; free turns are kept consumed as anti-abuse.
pub async fn fail_reservation(db: &SqlitePool, r: &Reservation) {
    if let (Some(ent_id), "entitlement") = (r.entitlement_id, r.source.as_str()) {
        let _ = sqlx::query("UPDATE entitlements SET tokens_used = tokens_used - ? WHERE id = ?")
            .bind(r.reserved_tokens)
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
            let charged_total = charge_tokens(total, r.token_multiplier);
            if let (Some(ent_id), "entitlement") = (r.entitlement_id, r.source.as_str()) {
                let delta = charged_total - r.reserved_tokens;
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
                "UPDATE usage_sessions SET total_tokens=?, status='usage_unknown', finished_at=datetime('now') WHERE id=?",
            )
            .bind(r.reserved_tokens)
            .bind(&r.session_id)
            .execute(db)
            .await;
        }
    }
}
