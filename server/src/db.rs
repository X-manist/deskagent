use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
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
                "gpt-5.4-mini",
                1_000_000i64,
                1990i64,
                30i64,
                1i64,
            ),
            ("标准月卡", "gpt-5.4", 3_000_000, 4990, 30, 2),
            ("年度会员", "gpt-5.4", 40_000_000, 49900, 365, 3),
        ];
        for (name, model, tokens, price, days, sort) in defaults {
            sqlx::query(
                "INSERT INTO packages (name, model, total_tokens, price_cents, duration_days, sort_order) VALUES (?,?,?,?,?,?)",
            )
            .bind(name)
            .bind(model)
            .bind(tokens)
            .bind(price)
            .bind(days)
            .bind(sort)
            .execute(pool)
            .await?;
        }
        tracing::info!("seeded {} default packages", defaults.len());
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
