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
    ensure_column(pool, "packages", "points", "INTEGER NOT NULL DEFAULT 0").await?;
    ensure_column(
        pool,
        "packages",
        "models_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )
    .await?;
    ensure_column(
        pool,
        "orders",
        "pkg_token_multiplier",
        "REAL NOT NULL DEFAULT 1.0",
    )
    .await?;
    ensure_column(pool, "orders", "pkg_points", "INTEGER NOT NULL DEFAULT 0").await?;
    ensure_column(
        pool,
        "orders",
        "pkg_models_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )
    .await?;
    ensure_column(
        pool,
        "entitlements",
        "token_multiplier",
        "REAL NOT NULL DEFAULT 1.0",
    )
    .await?;
    ensure_column(pool, "entitlements", "points", "INTEGER NOT NULL DEFAULT 0").await?;
    ensure_column(
        pool,
        "entitlements",
        "models_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS model_pricing (
          model_id TEXT PRIMARY KEY,
          point_multiplier REAL NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_by TEXT
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS migration_flags (
          flag TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )",
    )
    .execute(pool)
    .await?;
    ensure_column(pool, "remote_pairings", "relay_session_id", "TEXT").await?;
    ensure_column(pool, "remote_commands", "relay_session_id", "TEXT").await?;
    ensure_remote_relay_tables(pool).await?;
    backfill_points(pool).await?;
    Ok(())
}

async fn ensure_remote_relay_tables(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS remote_relay_sessions (
          id              TEXT PRIMARY KEY,
          code            TEXT NOT NULL UNIQUE,
          user_id         INTEGER NOT NULL REFERENCES users(id),
          machine_id      TEXT NOT NULL REFERENCES remote_machines(id),
          client_key      TEXT NOT NULL,
          machine_key     TEXT NOT NULL,
          direct_url      TEXT,
          direct_urls_json TEXT NOT NULL DEFAULT '[]',
          status          TEXT NOT NULL DEFAULT 'pending',
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at      TEXT NOT NULL,
          connected_at    TEXT,
          last_client_at  TEXT,
          last_machine_at TEXT,
          revoked_at      TEXT
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_remote_relay_sessions_machine
         ON remote_relay_sessions(machine_id, status, expires_at)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_remote_relay_sessions_user
         ON remote_relay_sessions(user_id, created_at)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS remote_relay_messages (
          id           TEXT PRIMARY KEY,
          session_id   TEXT NOT NULL REFERENCES remote_relay_sessions(id),
          user_id      INTEGER NOT NULL REFERENCES users(id),
          machine_id   TEXT NOT NULL REFERENCES remote_machines(id),
          direction    TEXT NOT NULL,
          kind         TEXT NOT NULL DEFAULT 'message',
          request_id   TEXT,
          payload_json TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          claimed_at   TEXT,
          finished_at  TEXT
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_remote_relay_messages_poll
         ON remote_relay_messages(machine_id, direction, status, created_at)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_remote_relay_messages_session
         ON remote_relay_messages(session_id, direction, created_at)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS remote_relay_files (
          id             TEXT PRIMARY KEY,
          session_id     TEXT NOT NULL REFERENCES remote_relay_sessions(id),
          user_id        INTEGER NOT NULL REFERENCES users(id),
          machine_id     TEXT NOT NULL REFERENCES remote_machines(id),
          name           TEXT NOT NULL,
          content_type   TEXT NOT NULL,
          size           INTEGER NOT NULL,
          content        BLOB NOT NULL,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at     TEXT NOT NULL,
          downloaded_at  TEXT
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_remote_relay_files_session
         ON remote_relay_files(session_id, created_at)",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS remote_files (
          id             TEXT PRIMARY KEY,
          user_id        INTEGER NOT NULL REFERENCES users(id),
          machine_id     TEXT NOT NULL REFERENCES remote_machines(id),
          name           TEXT NOT NULL,
          content_type   TEXT NOT NULL,
          size           INTEGER NOT NULL,
          content        BLOB,
          direct_url     TEXT,
          packaged       INTEGER NOT NULL DEFAULT 0,
          source_count   INTEGER NOT NULL DEFAULT 1,
          entry_count    INTEGER NOT NULL DEFAULT 1,
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at     TEXT NOT NULL,
          downloaded_at  TEXT
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_remote_files_machine
         ON remote_files(user_id, machine_id, created_at)",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn backfill_points(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "UPDATE packages
         SET points = CASE WHEN points > 0 THEN points ELSE total_tokens END,
             models_json = CASE
               WHEN models_json IS NOT NULL AND models_json != '' AND models_json != '[]' THEN models_json
               ELSE json_array(model)
             END
         WHERE points = 0 OR models_json IS NULL OR models_json = '' OR models_json = '[]'",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "UPDATE orders
         SET pkg_points = CASE WHEN pkg_points > 0 THEN pkg_points ELSE pkg_tokens END,
             pkg_models_json = CASE
               WHEN pkg_models_json IS NOT NULL AND pkg_models_json != '' AND pkg_models_json != '[]' THEN pkg_models_json
               ELSE json_array(pkg_model)
             END
         WHERE pkg_points = 0 OR pkg_models_json IS NULL OR pkg_models_json = '' OR pkg_models_json = '[]'",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "UPDATE entitlements
         SET points = CASE WHEN points > 0 THEN points ELSE token_allowance END,
             models_json = CASE
               WHEN models_json IS NOT NULL AND models_json != '' AND models_json != '[]' THEN models_json
               ELSE json_array(model)
             END
         WHERE points = 0 OR models_json IS NULL OR models_json = '' OR models_json = '[]'",
    )
    .execute(pool)
    .await?;

    normalize_legacy_point_pricing_once(pool).await?;
    Ok(())
}

async fn normalize_legacy_point_pricing_once(pool: &SqlitePool) -> Result<()> {
    let already_applied: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM migration_flags WHERE flag = ?")
            .bind("points_v2_cents")
            .fetch_one(pool)
            .await?;
    if already_applied > 0 {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    // Old package rows stored token allowances as points. In the new display
    // model, 1 yuan = 100 integer points, so cents map directly to points.
    sqlx::query(
        "UPDATE packages
         SET points = price_cents,
             total_tokens = price_cents
         WHERE price_cents > 0 AND points >= 100000",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE orders
         SET pkg_points = amount_cents,
             pkg_tokens = amount_cents
         WHERE amount_cents > 0 AND pkg_points >= 100000",
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE entitlements
         SET points = (
               SELECT orders.amount_cents FROM orders WHERE orders.id = entitlements.order_id
             ),
             token_allowance = (
               SELECT orders.amount_cents FROM orders WHERE orders.id = entitlements.order_id
             )
         WHERE order_id IS NOT NULL
           AND points >= 100000
           AND EXISTS (
             SELECT 1 FROM orders
             WHERE orders.id = entitlements.order_id AND orders.amount_cents > 0
           )",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO migration_flags (flag) VALUES (?)")
        .bind("points_v2_cents")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
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
                1990i64,
                1990i64,
                30i64,
                1i64,
            ),
            ("标准月卡", cfg.default_model.as_str(), 4990, 4990, 30, 2),
            ("年度会员", cfg.default_model.as_str(), 49900, 49900, 365, 3),
        ];
        for (name, model, tokens, price, days, sort) in defaults {
            sqlx::query(
                "INSERT INTO packages (name, model, total_tokens, token_multiplier, points, models_json, price_cents, duration_days, sort_order)
                 VALUES (?,?,?,?,?,json_array(?),?,?,?)",
            )
            .bind(name)
            .bind(model)
            .bind(tokens)
            .bind(1.0f64)
            .bind(tokens)
            .bind(model)
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
