use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::routing::get;
use axum::Router;
use deskagent_server::auth::issue_user_token;
use deskagent_server::config::Config;
use deskagent_server::db;
use deskagent_server::routes;
use deskagent_server::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;

async fn app() -> (Router, String) {
    let db_path =
        std::env::temp_dir().join(format!("deskagent-remote-test-{}.db", uuid::Uuid::new_v4()));
    let mut cfg = Config::from_env();
    cfg.database_url = format!("sqlite://{}?mode=rwc", db_path.display());
    cfg.user_jwt_secret = "remote-test-secret".to_string();
    cfg.sms_provider = "mock".to_string();
    let pool = db::connect(&cfg).await.unwrap();
    db::migrate(&pool).await.unwrap();
    db::bootstrap(&pool, &cfg).await.unwrap();
    let uid: i64 = sqlx::query_scalar(
        "INSERT INTO users (phone, last_login_at) VALUES ('13800000000', datetime('now')) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let token = issue_user_token(&cfg.user_jwt_secret, uid, "13800000000");
    let state = AppState {
        cfg: Arc::new(cfg),
        db: pool,
        http: reqwest::Client::new(),
    };
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .merge(routes::remote::router())
        .with_state(state);
    (app, token)
}

async fn json_request(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    (status, json)
}

async fn machine_request(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let json = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    (status, json)
}

async fn text_request(app: &Router, method: Method, path: &str) -> (StatusCode, String) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    (status, text)
}

#[tokio::test]
async fn remote_pairing_and_command_flow() {
    let (app, user_token) = app().await;

    let (status, registered) = json_request(
        &app,
        Method::POST,
        "/api/remote/machines",
        &user_token,
        json!({
            "machine_id": "machine-test-1",
            "label": "Test Mac",
            "hostname": "test-host",
            "platform": "darwin",
            "metadata": { "workspaceDir": "/tmp/workspace" }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{registered}");
    let machine_id = registered["machine_id"].as_str().unwrap();
    let machine_token = registered["machine_token"].as_str().unwrap();

    let (status, pairing) = json_request(
        &app,
        Method::POST,
        &format!("/api/remote/machines/{machine_id}/pairing"),
        &user_token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{pairing}");
    let code = pairing["code"].as_str().unwrap();
    assert_eq!(code.len(), 8);
    let web_url = pairing["payload"]["web_url"].as_str().unwrap();
    assert!(
        web_url.ends_with(&format!("/remote?code={code}")),
        "{web_url}"
    );
    assert_eq!(
        pairing["payload"]["server_url"].as_str().unwrap(),
        "http://127.0.0.1:8787"
    );

    let (status, html) = text_request(&app, Method::GET, &format!("/remote?code={code}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("智界助手远程连接"));
    assert!(html.contains(&format!("value=\"{code}\"")));
    assert!(html.contains("/api/remote/machines/"));

    let (status, consumed) = json_request(
        &app,
        Method::POST,
        &format!("/api/remote/pairings/{code}"),
        &user_token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{consumed}");
    assert_eq!(consumed["machine_id"].as_str().unwrap(), machine_id);

    let (status, created) = json_request(
        &app,
        Method::POST,
        &format!("/api/remote/machines/{machine_id}/commands"),
        &user_token,
        json!({ "command_type": "chat_message", "payload": { "text": "帮我整理桌面" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let command_id = created["command_id"].as_str().unwrap();

    let (status, polled) = machine_request(
        &app,
        Method::GET,
        "/api/remote/machine/commands",
        machine_token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{polled}");
    assert_eq!(polled["commands"].as_array().unwrap().len(), 1);
    assert_eq!(polled["commands"][0]["id"].as_str().unwrap(), command_id);

    let (status, result) = machine_request(
        &app,
        Method::POST,
        &format!("/api/remote/machine/commands/{command_id}/result"),
        machine_token,
        json!({ "ok": true, "result": { "thread_id": "thread-1" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");

    let (status, commands) = json_request(
        &app,
        Method::GET,
        &format!("/api/remote/machines/{machine_id}/commands"),
        &user_token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{commands}");
    assert_eq!(
        commands["commands"][0]["status"].as_str().unwrap(),
        "completed"
    );
    assert_eq!(
        commands["commands"][0]["result"]["thread_id"]
            .as_str()
            .unwrap(),
        "thread-1"
    );
}
