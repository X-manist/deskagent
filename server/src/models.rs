use std::collections::HashMap;

use serde_json::json;
use sqlx::SqlitePool;

use crate::config::{Config, ModelConfig};
use crate::error::AppResult;

fn safe_multiplier(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else if fallback.is_finite() && fallback > 0.0 {
        fallback
    } else {
        1.0
    }
}

pub async fn multiplier_overrides(db: &SqlitePool) -> AppResult<HashMap<String, f64>> {
    let rows: Vec<(String, f64)> =
        sqlx::query_as("SELECT model_id, point_multiplier FROM model_pricing")
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .filter(|(id, value)| !id.trim().is_empty() && value.is_finite() && *value > 0.0)
        .collect())
}

pub async fn model_with_pricing(
    cfg: &Config,
    db: &SqlitePool,
    id: &str,
) -> AppResult<Option<ModelConfig>> {
    let Some(mut model) = cfg.model(id) else {
        return Ok(None);
    };
    if let Some(multiplier) = sqlx::query_scalar::<_, f64>(
        "SELECT point_multiplier FROM model_pricing WHERE model_id = ?",
    )
    .bind(&model.id)
    .fetch_optional(db)
    .await?
    {
        model.point_multiplier = safe_multiplier(multiplier, model.point_multiplier);
    }
    Ok(Some(model))
}

pub async fn public_models(cfg: &Config, db: &SqlitePool) -> AppResult<Vec<serde_json::Value>> {
    let overrides = multiplier_overrides(db).await?;
    Ok(cfg
        .models
        .iter()
        .map(|model| {
            let override_multiplier = overrides
                .get(&model.id)
                .copied()
                .map(|value| safe_multiplier(value, model.point_multiplier));
            let point_multiplier = override_multiplier.unwrap_or(model.point_multiplier);
            let pricing_overridden = override_multiplier
                .map(|value| (value - model.point_multiplier).abs() >= 0.000_000_001)
                .unwrap_or(false);
            json!({
                "id": &model.id,
                "name": &model.display_name,
                "display_name": &model.display_name,
                "provider": &model.provider,
                "configured": !model.api_key.trim().is_empty(),
                "point_multiplier": point_multiplier,
                "default_point_multiplier": model.point_multiplier,
                "pricing_overridden": pricing_overridden,
            })
        })
        .collect())
}
