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

async fn json_request_with_headers(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let req = builder.body(Body::from(body.to_string())).unwrap();
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

async fn text_request_with_headers(
    app: &Router,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, String) {
    let mut builder = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let req = builder.body(Body::empty()).unwrap();
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
        web_url.contains(&format!("/api/remote/web?code={code}#k=")),
        "{web_url}"
    );
    assert_eq!(
        pairing["payload"]["mode"].as_str().unwrap(),
        "relay-encrypted"
    );
    assert!(pairing["relay_session_id"].as_str().unwrap().len() > 20);
    assert_eq!(
        pairing["payload"]["server_url"].as_str().unwrap(),
        "http://127.0.0.1:8787"
    );

    let (status, prefixed_pairing) = json_request_with_headers(
        &app,
        Method::POST,
        &format!("/api/remote/machines/{machine_id}/pairing"),
        &user_token,
        json!({}),
        &[
            ("x-forwarded-proto", "https"),
            ("x-forwarded-host", "admin-deskagent.example.test"),
            ("x-forwarded-prefix", "/relay-e2e/"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{prefixed_pairing}");
    let prefixed_code = prefixed_pairing["code"].as_str().unwrap();
    assert!(prefixed_pairing["payload"]["web_url"]
        .as_str()
        .unwrap()
        .starts_with(&format!(
            "https://admin-deskagent.example.test/relay-e2e/api/remote/web?code={prefixed_code}#k="
        )));
    assert_eq!(
        prefixed_pairing["payload"]["server_url"].as_str().unwrap(),
        "https://admin-deskagent.example.test/relay-e2e"
    );

    let (status, prefixed_html) = text_request_with_headers(
        &app,
        Method::GET,
        &format!("/api/remote/web?code={prefixed_code}"),
        &[("x-forwarded-prefix", "/relay-e2e")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(prefixed_html.contains("const apiBase = \"/relay-e2e\""));

    let (status, api_html) =
        text_request(&app, Method::GET, &format!("/api/remote/web?code={code}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(api_html.contains("智界助手远程连接"));
    assert!(api_html.contains(&format!("const initialCode = \"{code}\"")));
    assert!(api_html.contains("/api/remote/relay/pairings/"));

    let (status, html) = text_request(&app, Method::GET, &format!("/remote?code={code}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains("智界助手远程连接"));
    assert!(html.contains(&format!("const initialCode = \"{code}\"")));
    assert!(html.contains("/api/remote/relay/pairings/"));

    let (status, relay) = json_request(
        &app,
        Method::POST,
        &format!("/api/remote/relay/pairings/{code}"),
        "",
        json!({ "client_key": pairing["payload"]["client_key"].as_str().unwrap() }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{relay}");
    let relay_session_id = relay["session_id"].as_str().unwrap();
    assert_eq!(relay["machine_id"].as_str().unwrap(), machine_id);

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

    let (status, relay_created) = json_request(
        &app,
        Method::POST,
        &format!("/api/remote/relay/sessions/{relay_session_id}/commands"),
        "",
        json!({ "command_type": "chat_message", "payload": { "text": "公网远程任务" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{relay_created}");
    let relay_command_id = relay_created["command_id"].as_str().unwrap();

    let (status, relayed) = machine_request(
        &app,
        Method::GET,
        "/api/remote/machine/commands",
        machine_token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{relayed}");
    assert_eq!(
        relayed["commands"][0]["id"].as_str().unwrap(),
        relay_command_id
    );

    let (status, relay_result) = machine_request(
        &app,
        Method::POST,
        &format!("/api/remote/machine/commands/{relay_command_id}/result"),
        machine_token,
        json!({ "ok": true, "result": { "events": [{ "type": "message", "text": "公网回复" }] } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{relay_result}");

    let (status, relay_commands) = json_request(
        &app,
        Method::GET,
        &format!("/api/remote/relay/sessions/{relay_session_id}/commands"),
        "",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{relay_commands}");
    assert_eq!(
        relay_commands["commands"][0]["status"].as_str().unwrap(),
        "completed"
    );
    assert_eq!(
        relay_commands["commands"][0]["result"]["events"][0]["text"]
            .as_str()
            .unwrap(),
        "公网回复"
    );

    let content =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"hello phone");
    let (status, uploaded) = machine_request(
        &app,
        Method::POST,
        "/api/remote/machine/files",
        machine_token,
        json!({
            "name": "中文 文件.txt",
            "size": 11,
            "content_type": "text/plain; charset=utf-8",
            "content_base64": content
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    let file_id = uploaded["file"]["id"].as_str().unwrap();

    let (status, relay_files) = json_request(
        &app,
        Method::GET,
        &format!("/api/remote/relay/sessions/{relay_session_id}/files"),
        "",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{relay_files}");
    assert_eq!(relay_files["files"][0]["id"].as_str().unwrap(), file_id);
    assert_eq!(
        relay_files["files"][0]["large_file"].as_bool().unwrap(),
        false
    );

    let (status, prefixed_files) = json_request_with_headers(
        &app,
        Method::GET,
        &format!("/api/remote/relay/sessions/{relay_session_id}/files"),
        "",
        json!({}),
        &[("x-forwarded-prefix", "/relay-e2e")],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{prefixed_files}");
    assert!(prefixed_files["files"][0]["download_url"]
        .as_str()
        .unwrap()
        .starts_with("/relay-e2e/api/remote/files/"));

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/remote/files/{file_id}/download.txt"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("filename*=UTF-8''"));
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&bytes[..], b"hello phone");
}
