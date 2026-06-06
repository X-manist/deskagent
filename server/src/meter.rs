use sqlx::SqlitePool;

use crate::crypto;
use crate::error::{AppError, AppResult};

pub const POINT_SCALE: i64 = 1_000_000;

#[derive(Debug, Clone)]
pub struct Reservation {
    pub session_id: String,
    pub source: String, // 'free' | 'entitlement'
    pub entitlement_id: Option<i64>,
    pub model: String,
    pub reserved_point_micros: i64,
    pub point_multiplier: f64,
}

pub fn points_to_micros(points: i64) -> i64 {
    points.saturating_mul(POINT_SCALE)
}

pub fn display_points_from_micros(micros: i64) -> i64 {
    if micros <= 0 {
        return 0;
    }
    (micros.saturating_add(POINT_SCALE / 2)) / POINT_SCALE
}

pub fn display_used_points(used_micros: i64) -> i64 {
    display_points_from_micros(used_micros)
}

pub fn display_remaining_points(total_points: i64, used_micros: i64) -> i64 {
    display_points_from_micros(remaining_point_micros(total_points, used_micros))
}

pub fn remaining_point_micros(total_points: i64, used_micros: i64) -> i64 {
    points_to_micros(total_points)
        .saturating_sub(used_micros)
        .max(0)
}

fn charge_point_micros(tokens: i64, multiplier: f64) -> i64 {
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
        let reserve_charge = charge_point_micros(reserve_tokens, model_point_multiplier);
        let res = sqlx::query(
            "UPDATE entitlements SET tokens_used = tokens_used + ?
             WHERE id = ? AND status = 'active' AND expires_at > datetime('now')
               AND ((CASE WHEN points > 0 THEN points ELSE token_allowance END) * ?) - tokens_used >= ?",
        )
        .bind(reserve_charge)
        .bind(ent_id)
        .bind(POINT_SCALE)
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
                reserved_point_micros: reserve_charge,
                point_multiplier: model_point_multiplier,
            });
        }
    }

    Err(AppError::quota(
        "积分不足或当前套餐不支持该模型，请切换模型或购买套餐后继续使用",
    ))
}

/// Refund a reservation when the upstream definitively failed before producing
/// any billable work (connect error / non-2xx / unreadable body). Entitlement
/// reservations are returned.
pub async fn fail_reservation(db: &SqlitePool, r: &Reservation) {
    if let Some(ent_id) = r.entitlement_id {
        let _ = sqlx::query("UPDATE entitlements SET tokens_used = tokens_used - ? WHERE id = ?")
            .bind(r.reserved_point_micros)
            .bind(ent_id)
            .execute(db)
            .await;
    }
    let _ = sqlx::query(
        "UPDATE usage_sessions SET reserved_tokens=0, total_tokens=0, status='failed', finished_at=datetime('now') WHERE id=?",
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
            let charged_total = charge_point_micros(total, r.point_multiplier);
            if let Some(ent_id) = r.entitlement_id {
                let delta = charged_total - r.reserved_point_micros;
                let _ = sqlx::query(
                    "UPDATE entitlements SET tokens_used = tokens_used + ? WHERE id = ?",
                )
                .bind(delta)
                .bind(ent_id)
                .execute(db)
                .await;
            }
            let _ = sqlx::query(
                "UPDATE usage_sessions SET reserved_tokens=?, prompt_tokens=?, completion_tokens=?, total_tokens=?, status='completed', finished_at=datetime('now') WHERE id=?",
            )
            .bind(charged_total)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charges_in_micro_points_per_million_tokens() {
        assert_eq!(charge_point_micros(0, 1.0), 0);
        assert_eq!(charge_point_micros(1, 1.0), 1);
        assert_eq!(charge_point_micros(1_000, 1.0), 1_000);
        assert_eq!(charge_point_micros(1_000_000, 1.0), POINT_SCALE);
        assert_eq!(charge_point_micros(1_000_000, 2.5), 2_500_000);
    }

    #[test]
    fn display_points_are_integer_rounded() {
        assert_eq!(display_points_from_micros(0), 0);
        assert_eq!(display_points_from_micros(499_999), 0);
        assert_eq!(display_points_from_micros(500_000), 1);
        assert_eq!(display_points_from_micros(1_499_999), 1);
        assert_eq!(display_points_from_micros(1_500_000), 2);
    }
}
