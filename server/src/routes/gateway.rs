use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::post;
use axum::Router;
use futures::StreamExt;
use serde_json::json;

use crate::auth::AuthUser;
use crate::error::{AppError, AppResult};
use crate::meter;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/responses", post(responses))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/chat/completions/ws", axum::routing::get(chat_ws))
}

fn extract_model(body: &serde_json::Value, default_model: &str) -> String {
    body.get("model")
        .and_then(|m| m.as_str())
        .unwrap_or(default_model)
        .to_string()
}

fn upstream_endpoint(base_url: &str, endpoint: &str) -> String {
    format!(
        "{}/{}",
        base_url
            .trim_end_matches('/')
            .trim_end_matches("/responses")
            .trim_end_matches("/chat/completions"),
        endpoint.trim_start_matches('/')
    )
}

/// Pull (prompt, completion, total) from a Responses API usage object.
fn parse_usage(v: &serde_json::Value) -> Option<(i64, i64, i64)> {
    let usage = v
        .get("response")
        .and_then(|r| r.get("usage"))
        .or_else(|| v.get("usage"))?;
    let input = usage
        .get("input_tokens")
        .or_else(|| usage.get("prompt_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .or_else(|| usage.get("completion_tokens"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let total = usage
        .get("total_tokens")
        .and_then(|x| x.as_i64())
        .unwrap_or(input + output);
    if total > 0 || input > 0 || output > 0 {
        Some((input, output, total))
    } else {
        None
    }
}

/// Scan an accumulated SSE text buffer for the most recent usage object.
fn scan_sse_usage(buf: &str) -> Option<(i64, i64, i64)> {
    let mut last = None;
    for line in buf.lines() {
        let line = line.trim_start();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(u) = parse_usage(&v) {
                    last = Some(u);
                }
            }
        }
    }
    last
}

async fn forward_metered(
    st: AppState,
    user: AuthUser,
    headers: HeaderMap,
    body: axum::body::Bytes,
    endpoint: &'static str,
) -> AppResult<Response> {
    if body.len() > st.cfg.max_body_bytes {
        return Err(AppError::bad("请求体过大"));
    }
    let json_body: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| AppError::bad("请求体不是合法 JSON"))?;
    let model = extract_model(&json_body, &st.cfg.default_model);
    let model_cfg = st
        .cfg
        .model(&model)
        .ok_or_else(|| AppError::bad(format!("模型未开放或不存在: {model}")))?;
    if model_cfg.api_key.trim().is_empty() {
        return Err(AppError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "model_not_configured",
            format!("模型服务未配置密钥: {}", model_cfg.display_name),
        ));
    }
    let wants_stream = json_body
        .get("stream")
        .and_then(|s| s.as_bool())
        .unwrap_or(false);

    // Reserve capacity before contacting upstream.
    let reservation = meter::reserve(
        &st.db,
        user.0.sub,
        &model,
        st.cfg.reserve_tokens,
        st.cfg.free_turns,
    )
    .await?;

    // Forward to the real relay with the server-side key.
    let url = upstream_endpoint(&model_cfg.base_url, endpoint);
    let mut req = st
        .http
        .post(&url)
        .bearer_auth(&model_cfg.api_key)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(accept) = headers.get(header::ACCEPT) {
        req = req.header(header::ACCEPT, accept);
    }
    let upstream = match req.body(body.to_vec()).send().await {
        Ok(r) => r,
        Err(e) => {
            // Could not reach upstream: refund the reservation (no work done).
            meter::fail_reservation(&st.db, &reservation).await;
            return Err(AppError::new(
                StatusCode::BAD_GATEWAY,
                "upstream_error",
                format!("无法连接模型服务: {e}"),
            ));
        }
    };

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    let is_sse = content_type.contains("text/event-stream") || wants_stream;

    if !status.is_success() {
        // Upstream rejected the request: refund the reservation (no usage).
        let txt = upstream.text().await.unwrap_or_default();
        meter::fail_reservation(&st.db, &reservation).await;
        let st_code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return Ok(Response::builder()
            .status(st_code)
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(txt))
            .unwrap());
    }

    if is_sse {
        let db = st.db.clone();
        let res = reservation.clone();
        let upstream_stream = upstream.bytes_stream();
        let ct = content_type.clone();

        let body_stream = async_stream::stream! {
            let mut acc = String::new();
            let mut stream = upstream_stream;
            let mut errored = false;
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        if let Ok(s) = std::str::from_utf8(&bytes) {
                            acc.push_str(s);
                            // Bound memory: keep only a recent tail once large.
                            // Drain on a char boundary to avoid panicking on UTF-8.
                            if acc.len() > 512 * 1024 {
                                let mut cut = acc.len() - 256 * 1024;
                                while cut < acc.len() && !acc.is_char_boundary(cut) {
                                    cut += 1;
                                }
                                acc.drain(0..cut);
                            }
                        }
                        yield Ok::<_, std::io::Error>(bytes);
                    }
                    Err(_) => {
                        errored = true;
                        break;
                    }
                }
            }
            let usage = scan_sse_usage(&acc);
            match (errored, usage) {
                (false, Some((p, c, t))) => meter::reconcile(&db, &res, p, c, Some(t)).await,
                _ => meter::reconcile(&db, &res, 0, 0, None).await,
            }
        };

        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, ct)
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from_stream(body_stream))
            .unwrap());
    }

    // Non-streaming JSON: read fully, meter from usage, pass through.
    let full = match upstream.bytes().await {
        Ok(b) => b,
        Err(e) => {
            meter::fail_reservation(&st.db, &reservation).await;
            return Err(AppError::new(
                StatusCode::BAD_GATEWAY,
                "upstream_error",
                format!("读取响应失败: {e}"),
            ));
        }
    };
    let usage = serde_json::from_slice::<serde_json::Value>(&full)
        .ok()
        .and_then(|v| parse_usage(&v));
    match usage {
        Some((p, c, t)) => meter::reconcile(&st.db, &reservation, p, c, Some(t)).await,
        None => meter::reconcile(&st.db, &reservation, 0, 0, None).await,
    }
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(full.to_vec()))
        .unwrap())
}

async fn responses(
    State(st): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    forward_metered(st, user, headers, body, "responses").await
}

async fn chat_completions(
    State(st): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    forward_metered(st, user, headers, body, "chat/completions").await
}

async fn chat_ws(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    user: AuthUser,
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(move |socket| handle_chat_ws(socket, st, user))
}

async fn handle_chat_ws(mut socket: WebSocket, st: AppState, user: AuthUser) {
    let Some(first) = socket.recv().await else {
        return;
    };
    let body_text = match first {
        Ok(Message::Text(text)) => text.to_string(),
        Ok(Message::Binary(bytes)) => match String::from_utf8(bytes.to_vec()) {
            Ok(text) => text,
            Err(_) => {
                let _ = socket
                    .send(Message::Text(
                        json!({"type":"error","error":{"message":"请求体不是合法 JSON"}})
                            .to_string()
                            .into(),
                    ))
                    .await;
                return;
            }
        },
        _ => return,
    };
    let body_bytes = body_text.as_bytes();
    if body_bytes.len() > st.cfg.max_body_bytes {
        let _ = socket
            .send(Message::Text(
                json!({"type":"error","error":{"message":"请求体过大"}})
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let json_body: serde_json::Value = match serde_json::from_str(&body_text) {
        Ok(v) => v,
        Err(_) => {
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","error":{"message":"请求体不是合法 JSON"}})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };
    let model = extract_model(&json_body, &st.cfg.default_model);
    let model_cfg = match st.cfg.model(&model) {
        Some(cfg) => cfg,
        None => {
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","error":{"message": format!("模型未开放或不存在: {model}")}})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };
    if model_cfg.api_key.trim().is_empty() {
        let _ = socket
            .send(Message::Text(
                json!({"type":"error","error":{"message": format!("模型服务未配置密钥: {}", model_cfg.display_name)}})
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }
    let reservation = match meter::reserve(
        &st.db,
        user.0.sub,
        &model,
        st.cfg.reserve_tokens,
        st.cfg.free_turns,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => {
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","error":{"message": e.message}})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };

    let url = upstream_endpoint(&model_cfg.base_url, "chat/completions");
    let upstream = match st
        .http
        .post(&url)
        .bearer_auth(&model_cfg.api_key)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream")
        .body(body_text.to_string())
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            meter::fail_reservation(&st.db, &reservation).await;
            let _ = socket
                .send(Message::Text(
                    json!({"type":"error","error":{"message": format!("无法连接模型服务: {e}")}})
                        .to_string()
                        .into(),
                ))
                .await;
            return;
        }
    };

    let status = upstream.status();
    if !status.is_success() {
        let txt = upstream.text().await.unwrap_or_default();
        meter::fail_reservation(&st.db, &reservation).await;
        let _ = socket
            .send(Message::Text(
                json!({"type":"error","status": status.as_u16(), "error":{"message": txt}})
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    }

    let mut acc = String::new();
    let mut upstream_stream = upstream.bytes_stream();
    let mut errored = false;
    while let Some(chunk) = upstream_stream.next().await {
        match chunk {
            Ok(bytes) => {
                if let Ok(s) = std::str::from_utf8(&bytes) {
                    acc.push_str(s);
                    if acc.len() > 512 * 1024 {
                        let mut cut = acc.len() - 256 * 1024;
                        while cut < acc.len() && !acc.is_char_boundary(cut) {
                            cut += 1;
                        }
                        acc.drain(0..cut);
                    }
                    if socket
                        .send(Message::Text(s.to_string().into()))
                        .await
                        .is_err()
                    {
                        errored = true;
                        break;
                    }
                } else if socket.send(Message::Binary(bytes)).await.is_err() {
                    errored = true;
                    break;
                }
            }
            Err(_) => {
                errored = true;
                break;
            }
        }
    }
    let usage = scan_sse_usage(&acc);
    match (errored, usage) {
        (false, Some((p, c, t))) => meter::reconcile(&st.db, &reservation, p, c, Some(t)).await,
        _ => meter::reconcile(&st.db, &reservation, 0, 0, None).await,
    }
    let _ = socket
        .send(Message::Text(json!({"type":"done"}).to_string().into()))
        .await;
}
