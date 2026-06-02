use sqlx::sqlite::SqlitePool;
use std::sync::Arc;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: SqlitePool,
    pub http: reqwest::Client,
}
