use axum::routing::get;
use axum::Router;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

use deskagent_server::config::Config;
use deskagent_server::db;
use deskagent_server::routes;
use deskagent_server::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    let _ = dotenvy::from_filename("../.env");

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,deskagent_server=debug".into()),
        )
        .init();

    let cfg = Config::from_env();
    let bind = cfg.bind_addr.clone();

    let db = db::connect(&cfg).await?;
    db::migrate(&db).await?;
    db::bootstrap(&db, &cfg).await?;

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;

    let state = AppState {
        cfg: Arc::new(cfg),
        db,
        http,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(routes::user::router())
        .merge(routes::billing::router())
        .merge(routes::gateway::router())
        .merge(routes::remote::router())
        .merge(routes::admin::router())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("deskagent-server listening on {bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}
