use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::str::FromStr;

use crate::config::Config;
use crate::crypto;

pub async fn connect(cfg: &Config) -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(&cfg.database_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

pub async fn migrate(pool: &SqlitePool) -> Result<()> {
    let sql = include_str!("../migrations/0001_init.sql");
    sqlx::raw_sql(sql).execute(pool).await?;
    ensure_column(
        pool,
        "packages",
        "token_multiplier",
        "REAL NOT NULL DEFAULT 1.0",
    )
    .await?;
    ensure_column(
        pool,
        "orders",
        "pkg_token_multiplier",
        "REAL NOT NULL DEFAULT 1.0",
    )
    .await?;
    ensure_column(
        pool,
        "entitlements",
        "token_multiplier",
        "REAL NOT NULL DEFAULT 1.0",
    )
    .await?;
    Ok(())
}

async fn ensure_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<()> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(pool)
        .await?;
    let exists = rows.iter().any(|row| {
        row.try_get::<String, _>("name")
            .map(|name| name == column)
            .unwrap_or(false)
    });
    if !exists {
        sqlx::query(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))
        .execute(pool)
        .await?;
    }
    Ok(())
}

/// Create the first admin (from env) and seed default packages if empty.
pub async fn bootstrap(pool: &SqlitePool, cfg: &Config) -> Result<()> {
    let admin_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM admins")
        .fetch_one(pool)
        .await?;
    if admin_count == 0 {
        let hash = crypto::hash_password(&cfg.admin_bootstrap_pass);
        sqlx::query("INSERT INTO admins (username, password_hash) VALUES (?, ?)")
            .bind(&cfg.admin_bootstrap_user)
            .bind(&hash)
            .execute(pool)
            .await?;
        tracing::info!("bootstrapped admin '{}'", cfg.admin_bootstrap_user);
    }

    let pkg_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM packages")
        .fetch_one(pool)
        .await?;
    if pkg_count == 0 {
        let defaults = [
            (
                "体验月卡",
                cfg.default_model.as_str(),
                1_000_000i64,
                1990i64,
                30i64,
                1i64,
            ),
            (
                "标准月卡",
                cfg.default_model.as_str(),
                3_000_000,
                4990,
                30,
                2,
            ),
            (
                "年度会员",
                cfg.default_model.as_str(),
                40_000_000,
                49900,
                365,
                3,
            ),
        ];
        for (name, model, tokens, price, days, sort) in defaults {
            sqlx::query(
                "INSERT INTO packages (name, model, total_tokens, token_multiplier, price_cents, duration_days, sort_order) VALUES (?,?,?,?,?,?,?)",
            )
            .bind(name)
            .bind(model)
            .bind(tokens)
            .bind(1.0f64)
            .bind(price)
            .bind(days)
            .bind(sort)
            .execute(pool)
            .await?;
        }
        tracing::info!("seeded {} default packages", defaults.len());
    } else if cfg.default_model == "glm-5.1" {
        let updated = sqlx::query(
            "UPDATE packages SET model = ?
             WHERE model IN ('gpt-5.4-mini', 'gpt-5.4')",
        )
        .bind(&cfg.default_model)
        .execute(pool)
        .await?;
        if updated.rows_affected() > 0 {
            tracing::info!(
                "migrated {} default package models to {}",
                updated.rows_affected(),
                cfg.default_model
            );
        }
    }
    Ok(())
}

pub async fn audit(pool: &SqlitePool, actor: &str, action: &str, detail: &str) {
    let _ = sqlx::query("INSERT INTO audit_logs (actor, action, detail) VALUES (?,?,?)")
        .bind(actor)
        .bind(action)
        .bind(detail)
        .execute(pool)
        .await;
}
