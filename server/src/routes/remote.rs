use axum::body::Body;
use axum::extract::Query;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{Html, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::{Duration, Utc};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::auth::AuthUser;
use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MACHINE_TOKEN_PREFIX: &str = "da_machine_";
const MAX_REMOTE_COMMANDS_PER_POLL: i64 = 8;
const RELAY_PAIRING_TTL_DAYS: i64 = 7;
const RELAY_SESSION_TTL_DAYS: i64 = 30;
const RELAY_FILE_TTL_HOURS: i64 = 24;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/remote/machines",
            get(list_machines).post(register_machine),
        )
        .route(
            "/api/remote/machines/{machine_id}/pairing",
            post(create_pairing),
        )
        .route(
            "/api/remote/machines/{machine_id}/commands",
            get(list_commands).post(create_command),
        )
        .route(
            "/api/remote/machines/{machine_id}/files",
            get(list_remote_files),
        )
        .route(
            "/api/remote/pairings/{code}",
            get(read_pairing).post(consume_pairing),
        )
        .route("/api/remote/machine/heartbeat", post(machine_heartbeat))
        .route("/api/remote/machine/commands", get(machine_poll_commands))
        .route(
            "/api/remote/machine/commands/{command_id}/result",
            post(machine_command_result),
        )
        .route(
            "/api/remote/relay/pairings/{code}",
            post(connect_relay_pairing),
        )
        .route(
            "/api/remote/relay/sessions/{session_id}/commands",
            get(list_relay_commands).post(create_relay_command),
        )
        .route(
            "/api/remote/relay/sessions/{session_id}/files",
            get(list_relay_files),
        )
        .route("/api/remote/machine/files", post(machine_upload_file))
        .route(
            "/api/remote/files/{file_id}/{name}",
            get(download_relay_file),
        )
        .route(
            "/api/remote/files/{file_id}",
            get(download_relay_file_plain),
        )
        .route("/api/remote/web", get(remote_web_page))
        .route("/remote", get(remote_web_page))
}

#[derive(Deserialize)]
struct RegisterMachineReq {
    #[serde(default)]
    machine_id: Option<String>,
    label: String,
    hostname: String,
    platform: String,
    #[serde(default)]
    app_version: Option<String>,
    #[serde(default)]
    public_key: Option<String>,
    #[serde(default)]
    metadata: serde_json::Value,
}

#[derive(Serialize)]
struct RegisterMachineResp {
    machine_id: String,
    machine_token: String,
}

fn random_secret(prefix: &str) -> String {
    let body: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
    format!("{prefix}{body}")
}

fn token_hash(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    let bytes = h.finalize();
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn machine_bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.strip_prefix("Bearer ")
                .or_else(|| s.strip_prefix("bearer "))
        })
        .map(|s| s.trim().to_string())
}

async fn auth_machine(st: &AppState, headers: &HeaderMap) -> AppResult<(String, i64)> {
    let token =
        machine_bearer(headers).ok_or_else(|| AppError::unauthorized("缺少机器连接凭证"))?;
    let hash = token_hash(&token);
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT id, user_id FROM remote_machines
         WHERE machine_token_hash = ? AND status = 'active' AND revoked_at IS NULL",
    )
    .bind(hash)
    .fetch_optional(&st.db)
    .await?;
    row.ok_or_else(|| AppError::unauthorized("机器连接凭证无效"))
}

fn sanitize_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn new_pairing_code() -> String {
    let alphabet = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| alphabet[rng.gen_range(0..alphabet.len())] as char)
        .collect()
}

async fn register_machine(
    State(st): State<AppState>,
    user: AuthUser,
    Json(req): Json<RegisterMachineReq>,
) -> AppResult<Json<RegisterMachineResp>> {
    let label = req.label.trim();
    let hostname = req.hostname.trim();
    let platform = req.platform.trim();
    if label.is_empty() || hostname.is_empty() || platform.is_empty() {
        return Err(AppError::bad("机器名称、主机名和平台不能为空"));
    }

    let machine_id = req
        .machine_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(crypto::new_uuid);
    let machine_token = random_secret(MACHINE_TOKEN_PREFIX);
    let metadata_json = serde_json::to_string(&req.metadata).unwrap_or_else(|_| "{}".to_string());

    sqlx::query(
        "INSERT INTO remote_machines
          (id, user_id, label, hostname, platform, app_version, machine_token_hash, public_key, metadata_json, status, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          label = excluded.label,
          hostname = excluded.hostname,
          platform = excluded.platform,
          app_version = excluded.app_version,
          machine_token_hash = excluded.machine_token_hash,
          public_key = excluded.public_key,
          metadata_json = excluded.metadata_json,
          status = 'active',
          revoked_at = NULL,
          last_seen_at = datetime('now')",
    )
    .bind(&machine_id)
    .bind(user.0.sub)
    .bind(label)
    .bind(hostname)
    .bind(platform)
    .bind(req.app_version.as_deref())
    .bind(token_hash(&machine_token))
    .bind(req.public_key.as_deref())
    .bind(metadata_json)
    .execute(&st.db)
    .await?;

    Ok(Json(RegisterMachineResp {
        machine_id,
        machine_token,
    }))
}

#[derive(Serialize)]
struct MachineSummary {
    id: String,
    label: String,
    hostname: String,
    platform: String,
    app_version: Option<String>,
    status: String,
    last_seen_at: Option<String>,
    created_at: String,
}

async fn list_machines(
    State(st): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        String,
    )> = sqlx::query_as(
        "SELECT id, label, hostname, platform, app_version, status, last_seen_at, created_at
             FROM remote_machines
             WHERE user_id = ? AND revoked_at IS NULL
             ORDER BY COALESCE(last_seen_at, created_at) DESC",
    )
    .bind(user.0.sub)
    .fetch_all(&st.db)
    .await?;
    let machines: Vec<MachineSummary> = rows
        .into_iter()
        .map(
            |(id, label, hostname, platform, app_version, status, last_seen_at, created_at)| {
                MachineSummary {
                    id,
                    label,
                    hostname,
                    platform,
                    app_version,
                    status,
                    last_seen_at,
                    created_at,
                }
            },
        )
        .collect();
    Ok(Json(json!({ "machines": machines })))
}

#[derive(Deserialize)]
struct CreatePairingReq {
    #[serde(default)]
    app_url: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    direct_url: Option<String>,
    #[serde(default)]
    direct_urls: Vec<String>,
    #[serde(default)]
    client_key: Option<String>,
    #[serde(default)]
    machine_key: Option<String>,
    #[serde(default)]
    mode: Option<String>,
}

fn public_server_url(headers: &HeaderMap) -> String {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("http");
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("127.0.0.1:8787");
    let prefix = forwarded_prefix(headers);
    format!("{scheme}://{host}{prefix}")
}

fn forwarded_prefix(headers: &HeaderMap) -> String {
    let Some(raw) = headers
        .get("x-forwarded-prefix")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "/")
    else {
        return String::new();
    };
    if raw.contains("://") || raw.contains('?') || raw.contains('#') || raw.contains('\\') {
        return String::new();
    }
    let segments = raw
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    if segments.is_empty() {
        String::new()
    } else {
        format!("/{}", segments.join("/"))
    }
}

fn public_path(headers: &HeaderMap, path: &str) -> String {
    format!("{}{}", forwarded_prefix(headers), path)
}

fn random_relay_key() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::thread_rng().gen::<[u8; 32]>())
}

fn truncate_utf8(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn content_type_for_name(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        "application/zip"
    } else if lower.ends_with(".pdf") {
        "application/pdf"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".txt") || lower.ends_with(".md") || lower.ends_with(".csv") {
        "text/plain; charset=utf-8"
    } else {
        "application/octet-stream"
    }
}

fn ascii_filename_fallback(name: &str) -> String {
    let cleaned = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_graphic() || ch == ' ' {
                match ch {
                    '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                    _ => ch,
                }
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        truncate_utf8(trimmed, 180)
    }
}

fn content_disposition_attachment(name: &str) -> String {
    let fallback = ascii_filename_fallback(name).replace(['"', '\\'], "_");
    format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        fallback,
        urlencoding::encode(name)
    )
}

async fn create_pairing(
    State(st): State<AppState>,
    user: AuthUser,
    Path(machine_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreatePairingReq>,
) -> AppResult<Json<serde_json::Value>> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM remote_machines WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(&machine_id)
    .bind(user.0.sub)
    .fetch_optional(&st.db)
    .await?;
    if exists.is_none() {
        return Err(AppError::bad("远程机器不存在"));
    }

    let code = {
        let mut picked = None;
        for _ in 0..12 {
            let candidate = new_pairing_code();
            let clash: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM remote_pairings WHERE code = ? AND consumed_at IS NULL AND datetime(expires_at) > datetime('now')",
            )
            .bind(&candidate)
            .fetch_optional(&st.db)
            .await?;
            if clash.is_none() {
                picked = Some(candidate);
                break;
            }
        }
        picked.ok_or_else(|| AppError::internal("无法生成连接码"))?
    };
    let pairing_id = crypto::new_uuid();
    let created_at = Utc::now();
    let created_at_text = created_at.to_rfc3339();
    let expires_at = (created_at + Duration::days(RELAY_PAIRING_TTL_DAYS)).to_rfc3339();
    let relay_expires_at = (created_at + Duration::days(RELAY_SESSION_TTL_DAYS)).to_rfc3339();
    let relay_session_id = crypto::new_uuid();
    let client_key = req
        .client_key
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(random_relay_key);
    let machine_key = req
        .machine_key
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(random_relay_key);
    let direct_urls = req
        .direct_urls
        .into_iter()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .collect::<Vec<_>>();
    let direct_url = req
        .direct_url
        .filter(|u| !u.trim().is_empty())
        .or_else(|| direct_urls.first().cloned());
    let direct_urls_json = serde_json::to_string(&direct_urls).unwrap_or_else(|_| "[]".to_string());
    let app_url = req
        .app_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| format!("deskagent://connect?code={code}"));
    let server_url = public_server_url(&headers);
    let web_url = req
        .web_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| format!("{server_url}/api/remote/web?code={code}#k={client_key}"));
    let payload = json!({
        "version": 3,
        "product": "deskagent",
        "mode": req.mode.as_deref().unwrap_or("relay-encrypted"),
        "code": code,
        "machine_id": machine_id,
        "relay_session_id": relay_session_id,
        "server_url": server_url,
        "app_url": app_url,
        "web_url": web_url,
        "direct_url": direct_url,
        "direct_urls": direct_urls,
        "crypto": "xsalsa20-poly1305",
        "client_key": client_key,
    });

    sqlx::query(
        "UPDATE remote_relay_sessions
         SET revoked_at = datetime('now')
         WHERE user_id = ? AND machine_id = ? AND status = 'pending' AND revoked_at IS NULL",
    )
    .bind(user.0.sub)
    .bind(&machine_id)
    .execute(&st.db)
    .await?;

    sqlx::query(
        "INSERT INTO remote_pairings (id, code, user_id, machine_id, payload_json, expires_at, relay_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&pairing_id)
    .bind(&code)
    .bind(user.0.sub)
    .bind(&machine_id)
    .bind(payload.to_string())
    .bind(&expires_at)
    .bind(&relay_session_id)
    .bind(&created_at_text)
    .execute(&st.db)
    .await?;

    sqlx::query(
        "INSERT INTO remote_relay_sessions
          (id, code, user_id, machine_id, client_key, machine_key, direct_url, direct_urls_json, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
    )
    .bind(&relay_session_id)
    .bind(&code)
    .bind(user.0.sub)
    .bind(&machine_id)
    .bind(&client_key)
    .bind(&machine_key)
    .bind(direct_url.as_deref())
    .bind(&direct_urls_json)
    .bind(&relay_expires_at)
    .execute(&st.db)
    .await?;

    Ok(Json(json!({
        "pairing_id": pairing_id,
        "relay_session_id": relay_session_id,
        "code": code,
        "created_at": created_at_text,
        "expires_at": expires_at,
        "relay_expires_at": relay_expires_at,
        "machine_key": machine_key,
        "payload": payload,
    })))
}

async fn read_pairing(
    State(st): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let code = sanitize_code(&code);
    let row: Option<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT p.machine_id, p.payload_json, p.expires_at, m.last_seen_at
         FROM remote_pairings p
         JOIN remote_machines m ON m.id = p.machine_id
         WHERE p.code = ? AND p.user_id = ? AND p.consumed_at IS NULL AND datetime(p.expires_at) > datetime('now')",
    )
    .bind(&code)
    .bind(user.0.sub)
    .fetch_optional(&st.db)
    .await?;
    let (machine_id, payload_json, expires_at, last_seen_at) =
        row.ok_or_else(|| AppError::bad("连接码无效或已过期"))?;
    let payload: serde_json::Value =
        serde_json::from_str(&payload_json).unwrap_or_else(|_| json!({}));
    Ok(Json(json!({
        "machine_id": machine_id,
        "expires_at": expires_at,
        "last_seen_at": last_seen_at,
        "payload": payload,
    })))
}

async fn consume_pairing(
    State(st): State<AppState>,
    user: AuthUser,
    Path(code): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let code = sanitize_code(&code);
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT p.id, p.machine_id, p.payload_json
         FROM remote_pairings p
         WHERE p.code = ? AND p.user_id = ? AND p.consumed_at IS NULL AND datetime(p.expires_at) > datetime('now')",
    )
    .bind(&code)
    .bind(user.0.sub)
    .fetch_optional(&st.db)
    .await?;
    let (pairing_id, machine_id, payload_json) =
        row.ok_or_else(|| AppError::bad("连接码无效或已过期"))?;
    sqlx::query("UPDATE remote_pairings SET consumed_at = datetime('now') WHERE id = ?")
        .bind(&pairing_id)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({
        "ok": true,
        "machine_id": machine_id,
        "payload": serde_json::from_str::<serde_json::Value>(&payload_json).unwrap_or_else(|_| json!({})),
    })))
}

#[derive(Deserialize)]
struct CreateCommandReq {
    #[serde(default = "default_command_type")]
    command_type: String,
    #[serde(default)]
    payload: serde_json::Value,
}

fn default_command_type() -> String {
    "chat_message".to_string()
}

async fn create_command(
    State(st): State<AppState>,
    user: AuthUser,
    Path(machine_id): Path<String>,
    Json(req): Json<CreateCommandReq>,
) -> AppResult<Json<serde_json::Value>> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM remote_machines WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(&machine_id)
    .bind(user.0.sub)
    .fetch_optional(&st.db)
    .await?;
    if exists.is_none() {
        return Err(AppError::bad("远程机器不存在"));
    }
    if req.command_type.trim().is_empty() {
        return Err(AppError::bad("命令类型不能为空"));
    }
    let command_id = crypto::new_uuid();
    sqlx::query(
        "INSERT INTO remote_commands (id, user_id, machine_id, command_type, payload_json)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&command_id)
    .bind(user.0.sub)
    .bind(&machine_id)
    .bind(req.command_type.trim())
    .bind(req.payload.to_string())
    .execute(&st.db)
    .await?;
    Ok(Json(
        json!({ "ok": true, "command_id": command_id, "status": "pending" }),
    ))
}

async fn list_commands(
    State(st): State<AppState>,
    user: AuthUser,
    Path(machine_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let rows: Vec<(String, String, String, String, Option<String>, Option<String>, String, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT id, command_type, payload_json, status, result_json, error, created_at, claimed_at, finished_at
             FROM remote_commands
             WHERE user_id = ? AND machine_id = ?
             ORDER BY created_at DESC
             LIMIT 50",
        )
        .bind(user.0.sub)
        .bind(&machine_id)
        .fetch_all(&st.db)
        .await?;
    let commands: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, command_type, payload_json, status, result_json, error, created_at, claimed_at, finished_at)| {
            json!({
                "id": id,
                "command_type": command_type,
                "payload": serde_json::from_str::<serde_json::Value>(&payload_json).unwrap_or_else(|_| json!({})),
                "status": status,
                "result": result_json.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
                "error": error,
                "created_at": created_at,
                "claimed_at": claimed_at,
                "finished_at": finished_at,
            })
        })
        .collect();
    Ok(Json(json!({ "commands": commands })))
}

#[derive(Deserialize)]
struct HeartbeatReq {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    metadata: serde_json::Value,
    #[serde(default)]
    pairing_code: Option<String>,
    #[serde(default)]
    relay_session_id: Option<String>,
}

async fn machine_heartbeat(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<HeartbeatReq>,
) -> AppResult<Json<serde_json::Value>> {
    let (machine_id, _) = auth_machine(&st, &headers).await?;
    let status = req.status.as_deref().unwrap_or("active");
    sqlx::query(
        "UPDATE remote_machines
         SET last_seen_at = datetime('now'), status = ?, metadata_json = ?
         WHERE id = ?",
    )
    .bind(status)
    .bind(req.metadata.to_string())
    .bind(&machine_id)
    .execute(&st.db)
    .await?;

    if let Some(session_id) = req
        .relay_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sqlx::query(
            "UPDATE remote_relay_sessions
             SET last_machine_at = datetime('now')
             WHERE id = ? AND machine_id = ? AND revoked_at IS NULL",
        )
        .bind(session_id)
        .bind(&machine_id)
        .execute(&st.db)
        .await?;
    }

    let pairing = if let Some(code) = req
        .pairing_code
        .as_deref()
        .map(sanitize_code)
        .filter(|value| !value.is_empty())
    {
        let row: Option<(
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = sqlx::query_as(
            "SELECT p.code, p.created_at, p.expires_at, p.consumed_at,
                    s.id, s.connected_at, s.last_client_at
             FROM remote_pairings p
             LEFT JOIN remote_relay_sessions s ON s.id = p.relay_session_id
             WHERE p.code = ? AND p.machine_id = ? AND datetime(p.expires_at) > datetime('now')
               AND (s.id IS NULL OR s.revoked_at IS NULL)
             ORDER BY p.created_at DESC
             LIMIT 1",
        )
        .bind(&code)
        .bind(&machine_id)
        .fetch_optional(&st.db)
        .await?;
        row.map(
            |(
                code,
                created_at,
                expires_at,
                consumed_at,
                relay_session_id,
                connected_at,
                last_client_at,
            )| {
                json!({
                    "code": code,
                    "created_at": created_at,
                    "expires_at": expires_at,
                    "consumed_at": consumed_at,
                    "relay_session_id": relay_session_id,
                    "connected_at": connected_at,
                    "last_client_at": last_client_at,
                })
            },
        )
    } else {
        None
    };

    Ok(Json(
        json!({ "ok": true, "machine_id": machine_id, "pairing": pairing }),
    ))
}

async fn machine_poll_commands(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<serde_json::Value>> {
    let (machine_id, user_id) = auth_machine(&st, &headers).await?;
    sqlx::query(
        "UPDATE remote_machines SET last_seen_at = datetime('now'), status = 'active' WHERE id = ?",
    )
    .bind(&machine_id)
    .execute(&st.db)
    .await?;

    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, command_type, payload_json, created_at
         FROM remote_commands
         WHERE machine_id = ? AND user_id = ? AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?",
    )
    .bind(&machine_id)
    .bind(user_id)
    .bind(MAX_REMOTE_COMMANDS_PER_POLL)
    .fetch_all(&st.db)
    .await?;

    let mut commands = Vec::new();
    for (id, command_type, payload_json, created_at) in rows {
        let updated = sqlx::query(
            "UPDATE remote_commands SET status = 'claimed', claimed_at = datetime('now')
             WHERE id = ? AND status = 'pending'",
        )
        .bind(&id)
        .execute(&st.db)
        .await?;
        if updated.rows_affected() == 1 {
            commands.push(json!({
                "id": id,
                "command_type": command_type,
                "payload": serde_json::from_str::<serde_json::Value>(&payload_json).unwrap_or_else(|_| json!({})),
                "created_at": created_at,
            }));
        }
    }

    Ok(Json(json!({ "commands": commands })))
}

#[derive(Deserialize)]
struct CommandResultReq {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    result: serde_json::Value,
    #[serde(default)]
    error: Option<String>,
}

async fn machine_command_result(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(command_id): Path<String>,
    Json(req): Json<CommandResultReq>,
) -> AppResult<Json<serde_json::Value>> {
    let (machine_id, user_id) = auth_machine(&st, &headers).await?;
    let status = if req.ok { "completed" } else { "failed" };
    let res = sqlx::query(
        "UPDATE remote_commands
         SET status = ?, result_json = ?, error = ?, finished_at = datetime('now')
         WHERE id = ? AND machine_id = ? AND user_id = ? AND status IN ('pending', 'claimed')",
    )
    .bind(status)
    .bind(req.result.to_string())
    .bind(req.error.as_deref())
    .bind(&command_id)
    .bind(&machine_id)
    .bind(user_id)
    .execute(&st.db)
    .await?;
    if res.rows_affected() != 1 {
        return Err(AppError::bad("远程命令不存在或已完成"));
    }
    Ok(Json(
        json!({ "ok": true, "command_id": command_id, "status": status }),
    ))
}

#[derive(Deserialize)]
struct UploadRemoteFileReq {
    name: String,
    size: i64,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    content_base64: Option<String>,
    #[serde(default)]
    direct_url: Option<String>,
    #[serde(default)]
    packaged: bool,
    #[serde(default)]
    source_count: Option<i64>,
    #[serde(default)]
    entry_count: Option<i64>,
    #[serde(default)]
    expires_at: Option<String>,
}

async fn machine_upload_file(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UploadRemoteFileReq>,
) -> AppResult<Json<serde_json::Value>> {
    let (machine_id, user_id) = auth_machine(&st, &headers).await?;
    let name = truncate_utf8(req.name.trim(), 180);
    if name.is_empty() {
        return Err(AppError::bad("文件名不能为空"));
    }
    if req.size < 0 {
        return Err(AppError::bad("文件大小无效"));
    }
    let direct_url = req
        .direct_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let content = match req
        .content_base64
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(raw) => {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(raw)
                .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(raw))
                .map_err(|_| AppError::bad("文件内容不是合法 base64"))?;
            if decoded.len() > st.cfg.remote_relay_file_max_bytes {
                return Err(AppError::bad(format!(
                    "公网中继文件不能超过 {} 字节，请使用局域网直链",
                    st.cfg.remote_relay_file_max_bytes
                )));
            }
            if req.size > 0 && decoded.len() as i64 != req.size {
                return Err(AppError::bad("文件大小与内容长度不一致"));
            }
            Some(decoded)
        }
        None => None,
    };
    if content.is_none() && direct_url.is_none() {
        return Err(AppError::bad("缺少文件内容或局域网下载链接"));
    }
    let size = content
        .as_ref()
        .map(|bytes| bytes.len() as i64)
        .unwrap_or(req.size);
    let file_id = crypto::new_uuid();
    let expires_at = req
        .expires_at
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| (Utc::now() + Duration::hours(RELAY_FILE_TTL_HOURS)).to_rfc3339());
    let content_type = req
        .content_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| content_type_for_name(&name).to_string());
    sqlx::query(
        "INSERT INTO remote_files
          (id, user_id, machine_id, name, content_type, size, content, direct_url, packaged, source_count, entry_count, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&file_id)
    .bind(user_id)
    .bind(&machine_id)
    .bind(&name)
    .bind(&content_type)
    .bind(size)
    .bind(content)
    .bind(direct_url.as_deref())
    .bind(if req.packaged { 1 } else { 0 })
    .bind(req.source_count.unwrap_or(1).max(1))
    .bind(req.entry_count.unwrap_or(1).max(1))
    .bind(&expires_at)
    .execute(&st.db)
    .await?;
    Ok(Json(json!({
        "ok": true,
        "file": {
            "id": file_id,
            "name": name,
            "size": size,
            "content_type": content_type,
            "expires_at": expires_at,
            "direct_url": direct_url,
        }
    })))
}

async fn list_remote_files(
    headers: HeaderMap,
    State(st): State<AppState>,
    user: AuthUser,
    Path(machine_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM remote_machines WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(&machine_id)
    .bind(user.0.sub)
    .fetch_optional(&st.db)
    .await?;
    if exists.is_none() {
        return Err(AppError::bad("远程机器不存在"));
    }
    let rows: Vec<(String, String, String, i64, Option<String>, i64, i64, i64, i64, String, String)> =
        sqlx::query_as(
            "SELECT id, name, content_type, size, direct_url, packaged, source_count, entry_count,
                    CASE WHEN content IS NULL AND direct_url IS NOT NULL THEN 1 ELSE 0 END AS large_file,
                    created_at, expires_at
             FROM remote_files
             WHERE user_id = ? AND machine_id = ? AND datetime(expires_at) > datetime('now')
             ORDER BY created_at DESC
             LIMIT 50",
        )
        .bind(user.0.sub)
        .bind(&machine_id)
        .fetch_all(&st.db)
        .await?;
    let prefix = forwarded_prefix(&headers);
    let files = rows
        .into_iter()
        .map(|(id, name, content_type, size, direct_url, packaged, source_count, entry_count, large_file, created_at, expires_at)| {
            json!({
                "id": id,
                "name": name,
                "content_type": content_type,
                "size": size,
                "download_url": format!("{}/api/remote/files/{}/{}", prefix, id, urlencoding::encode(&name)),
                "direct_url": direct_url,
                "large_file": large_file != 0,
                "packaged": packaged != 0,
                "source_count": source_count,
                "entry_count": entry_count,
                "created_at": created_at,
                "expires_at": expires_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "files": files })))
}

async fn download_relay_file(
    State(st): State<AppState>,
    Path((file_id, _name)): Path<(String, String)>,
) -> AppResult<Response> {
    download_file_by_id(&st, &file_id).await
}

async fn download_relay_file_plain(
    State(st): State<AppState>,
    Path(file_id): Path<String>,
) -> AppResult<Response> {
    download_file_by_id(&st, &file_id).await
}

async fn download_file_by_id(st: &AppState, file_id: &str) -> AppResult<Response> {
    let row: Option<(String, String, i64, Option<Vec<u8>>, Option<String>)> = sqlx::query_as(
        "SELECT name, content_type, size, content, direct_url
         FROM remote_files
         WHERE id = ? AND datetime(expires_at) > datetime('now')",
    )
    .bind(file_id)
    .fetch_optional(&st.db)
    .await?;
    let (name, content_type, size, content, direct_url) =
        row.ok_or_else(|| AppError::bad("文件不存在或已过期"))?;
    sqlx::query("UPDATE remote_files SET downloaded_at = datetime('now') WHERE id = ?")
        .bind(file_id)
        .execute(&st.db)
        .await?;
    let bytes = match content {
        Some(bytes) => bytes,
        None => {
            let url = direct_url.ok_or_else(|| AppError::bad("文件内容不存在"))?;
            let mut res = Response::new(Body::empty());
            *res.status_mut() = StatusCode::FOUND;
            res.headers_mut().insert(
                header::LOCATION,
                url.parse()
                    .map_err(|_| AppError::bad("局域网下载链接无效"))?,
            );
            return Ok(res);
        }
    };
    let mut res = Response::new(Body::from(bytes));
    *res.status_mut() = StatusCode::OK;
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        content_type
            .parse()
            .unwrap_or_else(|_| "application/octet-stream".parse().unwrap()),
    );
    headers.insert(header::CONTENT_LENGTH, size.to_string().parse().unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        content_disposition_attachment(&name).parse().unwrap(),
    );
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(res)
}

async fn relay_session_machine(st: &AppState, session_id: &str) -> AppResult<(i64, String)> {
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT user_id, machine_id
         FROM remote_relay_sessions
         WHERE id = ? AND status = 'connected' AND revoked_at IS NULL AND datetime(expires_at) > datetime('now')",
    )
    .bind(session_id)
    .fetch_optional(&st.db)
    .await?;
    row.ok_or_else(|| AppError::bad("远程连接无效或已过期"))
}

async fn connect_relay_pairing(
    State(st): State<AppState>,
    Path(code): Path<String>,
    Json(req): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    let code = sanitize_code(&code);
    let supplied_client_key = req
        .get("client_key")
        .or_else(|| req.get("clientKey"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let row: Option<(String, i64, String, String, String, Option<String>, String, String, String)> =
        sqlx::query_as(
            "SELECT s.id, s.user_id, s.machine_id, s.client_key, s.machine_key, s.direct_url, s.direct_urls_json, s.expires_at, s.status
             FROM remote_relay_sessions s
             JOIN remote_pairings p ON p.relay_session_id = s.id
             WHERE s.code = ? AND s.revoked_at IS NULL
               AND datetime(s.expires_at) > datetime('now')
               AND datetime(p.expires_at) > datetime('now')",
        )
        .bind(&code)
        .fetch_optional(&st.db)
        .await?;
    let (
        session_id,
        user_id,
        machine_id,
        client_key,
        _machine_key,
        direct_url,
        direct_urls_json,
        expires_at,
        _status,
    ) = row.ok_or_else(|| AppError::bad("连接码无效或已过期"))?;
    if supplied_client_key != client_key {
        return Err(AppError::unauthorized("远程连接密钥无效"));
    }
    sqlx::query(
        "UPDATE remote_relay_sessions
         SET status = 'connected', connected_at = COALESCE(connected_at, datetime('now')), last_client_at = datetime('now')
         WHERE id = ?",
    )
    .bind(&session_id)
    .execute(&st.db)
    .await?;
    let direct_urls: serde_json::Value =
        serde_json::from_str(&direct_urls_json).unwrap_or_else(|_| json!([]));
    Ok(Json(json!({
        "ok": true,
        "session_id": session_id,
        "machine_id": machine_id,
        "user_id": user_id,
        "code": code,
        "client_key": client_key,
        "direct_url": direct_url,
        "direct_urls": direct_urls,
        "expires_at": expires_at,
    })))
}

async fn create_relay_command(
    State(st): State<AppState>,
    Path(session_id): Path<String>,
    Json(req): Json<CreateCommandReq>,
) -> AppResult<Json<serde_json::Value>> {
    let (user_id, machine_id) = relay_session_machine(&st, &session_id).await?;
    if req.command_type.trim().is_empty() {
        return Err(AppError::bad("命令类型不能为空"));
    }
    let command_id = crypto::new_uuid();
    sqlx::query(
        "INSERT INTO remote_commands (id, user_id, machine_id, relay_session_id, command_type, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&command_id)
    .bind(user_id)
    .bind(&machine_id)
    .bind(&session_id)
    .bind(req.command_type.trim())
    .bind(req.payload.to_string())
    .execute(&st.db)
    .await?;
    sqlx::query("UPDATE remote_relay_sessions SET last_client_at = datetime('now') WHERE id = ?")
        .bind(&session_id)
        .execute(&st.db)
        .await?;
    Ok(Json(json!({
        "ok": true,
        "command_id": command_id,
        "status": "pending",
    })))
}

async fn list_relay_commands(
    State(st): State<AppState>,
    Path(session_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let (user_id, machine_id) = relay_session_machine(&st, &session_id).await?;
    let rows: Vec<(String, String, String, String, Option<String>, Option<String>, String, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT id, command_type, payload_json, status, result_json, error, created_at, claimed_at, finished_at
             FROM remote_commands
             WHERE user_id = ? AND machine_id = ? AND relay_session_id = ?
             ORDER BY created_at DESC
             LIMIT 50",
        )
        .bind(user_id)
        .bind(&machine_id)
        .bind(&session_id)
        .fetch_all(&st.db)
        .await?;
    sqlx::query("UPDATE remote_relay_sessions SET last_client_at = datetime('now') WHERE id = ?")
        .bind(&session_id)
        .execute(&st.db)
        .await?;
    let commands = rows
        .into_iter()
        .map(|(id, command_type, payload_json, status, result_json, error, created_at, claimed_at, finished_at)| {
            json!({
                "id": id,
                "command_type": command_type,
                "payload": serde_json::from_str::<serde_json::Value>(&payload_json).unwrap_or_else(|_| json!({})),
                "status": status,
                "result": result_json.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()),
                "error": error,
                "created_at": created_at,
                "claimed_at": claimed_at,
                "finished_at": finished_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "commands": commands })))
}

async fn list_relay_files(
    headers: HeaderMap,
    State(st): State<AppState>,
    Path(session_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let (user_id, machine_id) = relay_session_machine(&st, &session_id).await?;
    let rows: Vec<(String, String, String, i64, Option<String>, i64, i64, i64, i64, String, String)> =
        sqlx::query_as(
            "SELECT id, name, content_type, size, direct_url, packaged, source_count, entry_count,
                    CASE WHEN content IS NULL AND direct_url IS NOT NULL THEN 1 ELSE 0 END AS large_file,
                    created_at, expires_at
             FROM remote_files
             WHERE user_id = ? AND machine_id = ? AND datetime(expires_at) > datetime('now')
             ORDER BY created_at DESC
             LIMIT 50",
        )
        .bind(user_id)
        .bind(&machine_id)
        .fetch_all(&st.db)
        .await?;
    let prefix = forwarded_prefix(&headers);
    let files = rows
        .into_iter()
        .map(|(id, name, content_type, size, direct_url, packaged, source_count, entry_count, large_file, created_at, expires_at)| {
            json!({
                "id": id,
                "name": name,
                "content_type": content_type,
                "size": size,
                "download_url": format!("{}/api/remote/files/{}/{}", prefix, id, urlencoding::encode(&name)),
                "direct_url": direct_url,
                "large_file": large_file != 0,
                "packaged": packaged != 0,
                "source_count": source_count,
                "entry_count": entry_count,
                "created_at": created_at,
                "expires_at": expires_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "files": files })))
}

#[derive(Deserialize)]
struct RemotePageQuery {
    #[serde(default)]
    code: Option<String>,
}

async fn remote_web_page(headers: HeaderMap, Query(q): Query<RemotePageQuery>) -> Html<String> {
    Html(remote_page_html_modern(
        q.code.as_deref(),
        &public_path(&headers, ""),
    ))
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn remote_page_html_modern(code: Option<&str>, api_base: &str) -> String {
    let initial_code = html_escape(&code.map(sanitize_code).unwrap_or_default());
    let api_base_json = serde_json::to_string(api_base).unwrap_or_else(|_| "\"\"".to_string());
    r###"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>智界助手远程连接</title>
  <link rel="icon" href="data:," />
  <style>
    :root { color-scheme: light dark; --bg:#f6f7fb; --surface:#fff; --soft:#eef2f7; --line:#d7deea; --text:#172033; --muted:#667085; --accent:#2563eb; --ok:#15803d; --danger:#dc2626; }
    * { box-sizing:border-box; }
    html, body { margin:0; min-height:100%; }
    body { min-height:100svh; color:var(--text); background:var(--bg); font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
    main { width:min(820px,100%); min-height:100svh; margin:0 auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:12px 0; }
    h1 { margin:0; font-size:20px; line-height:1.2; }
    .pill { padding:6px 9px; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:var(--surface); font-size:12px; }
    .panel { border:1px solid var(--line); border-radius:8px; background:var(--surface); overflow:hidden; }
    .status { padding:10px 12px; border-bottom:1px solid var(--line); color:var(--muted); font-size:13px; line-height:1.45; }
    .messages { flex:1; min-height:280px; max-height:55svh; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:9px; background:var(--soft); }
    .msg { max-width:88%; padding:10px 12px; border-radius:13px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.55; font-size:15px; }
    .me { align-self:flex-end; color:#fff; background:var(--accent); border-bottom-right-radius:4px; }
    .ai { align-self:flex-start; border:1px solid var(--line); background:var(--surface); border-bottom-left-radius:4px; }
    .sys { align-self:center; color:var(--muted); background:var(--surface); border:1px solid var(--line); font-size:13px; }
    form { display:flex; gap:8px; padding:10px; border-top:1px solid var(--line); }
    textarea { flex:1; min-height:48px; max-height:140px; resize:vertical; padding:10px; border:1px solid var(--line); border-radius:8px; font:inherit; font-size:16px; }
    button { min-width:72px; border:0; border-radius:8px; color:#fff; background:var(--accent); font:inherit; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .files { padding:10px; display:flex; flex-direction:column; gap:8px; }
    .files:empty::before { content:"暂无可下载文件"; color:var(--muted); font-size:13px; }
    .file { display:flex; justify-content:space-between; gap:10px; padding:10px; border:1px solid var(--line); border-radius:8px; color:var(--text); text-decoration:none; }
    .file span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .file span:last-child { flex:0 0 auto; color:var(--muted); font-size:12px; }
    .err { color:var(--danger); }
    @media (max-width:560px){ main{padding:0}.panel{border-left:0;border-right:0;border-radius:0}.messages{max-height:calc(100svh - 210px)} header{padding:12px}.msg{max-width:92%} }
    @media (prefers-color-scheme: dark){ :root{--bg:#0f131a;--surface:#161b24;--soft:#10151d;--line:#293241;--text:#edf2f7;--muted:#98a2b3;--accent:#3b82f6;} }
  </style>
</head>
<body>
  <main>
    <header><h1>智界助手</h1><span class="pill" id="state">连接中</span></header>
    <section class="panel">
      <div class="status" id="status">正在连接桌面端...</div>
      <div class="messages" id="messages"></div>
      <form id="form">
        <textarea id="text" placeholder="输入要发送给电脑上的智界助手的任务..."></textarea>
        <button id="send" type="submit">发送</button>
      </form>
    </section>
    <section class="panel"><div class="status">可下载文件</div><div class="files" id="files"></div></section>
  </main>
  <script>
    const initialCode = "__INITIAL_CODE__";
    const params = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    const code = (params.get('code') || initialCode || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    const clientKey = hashParams.get('k') || params.get('k') || '';
    const apiBase = __API_BASE_JSON__;
    const stateEl = document.getElementById('state');
    const statusEl = document.getElementById('status');
    const messagesEl = document.getElementById('messages');
    const filesEl = document.getElementById('files');
    const form = document.getElementById('form');
    const textEl = document.getElementById('text');
    const sendEl = document.getElementById('send');
    let sessionId = '';
    let machineId = '';
    let polling = null;
    let activeCommandId = '';
    const shownCommands = new Set();
    function setState(text, error=false){ stateEl.textContent=text; statusEl.textContent=text; statusEl.classList.toggle('err', error); }
    function add(text, cls='sys'){ const el=document.createElement('div'); el.className='msg '+cls; el.textContent=text; messagesEl.appendChild(el); messagesEl.scrollTop=messagesEl.scrollHeight; return el; }
    function size(n){ n=Number(n||0); if(n>=1073741824)return(n/1073741824).toFixed(1)+' GB'; if(n>=1048576)return(n/1048576).toFixed(1)+' MB'; if(n>=1024)return(n/1024).toFixed(1)+' KB'; return n+' B'; }
    async function api(path, options={}){ const res=await fetch(apiBase+path,{method:options.method||'GET',headers:{'Content-Type':'application/json'},body:options.body?JSON.stringify(options.body):undefined}); const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error((data.error&&data.error.message)||'请求失败 ('+res.status+')'); return data; }
    function latestAssistant(result){ const events=(result&&result.events)||[]; for(let i=events.length-1;i>=0;i--){ if(events[i].type==='message'&&events[i].text) return events[i].text; } for(let i=events.length-1;i>=0;i--){ if(events[i].type==='delta'&&events[i].text) return events[i].text; } return ''; }
    async function connect(){ if(!code) throw new Error('缺少连接码，请重新扫码'); if(!clientKey) throw new Error('缺少连接密钥，请重新扫码'); const info=await api('/api/remote/relay/pairings/'+encodeURIComponent(code),{method:'POST',body:{client_key:clientKey}}); sessionId=info.session_id; machineId=info.machine_id; stateEl.textContent='已连接'; statusEl.textContent='已连接到电脑 '+machineId.slice(0,12); add('已通过中心节点连接到桌面端。'); await refreshFiles(); textEl.focus(); }
    async function sendMessage(text){ const created=await api('/api/remote/relay/sessions/'+encodeURIComponent(sessionId)+'/commands',{method:'POST',body:{command_type:'chat_message',payload:{text}}}); activeCommandId=created.command_id; return created.command_id; }
    async function refreshCommands(){ if(!sessionId) return; const data=await api('/api/remote/relay/sessions/'+encodeURIComponent(sessionId)+'/commands'); const command=(data.commands||[]).find(c=>c.id===activeCommandId); if(command){ if(command.status==='completed'){ const reply=latestAssistant(command.result)||'任务已完成。'; if(!shownCommands.has(command.id)){ shownCommands.add(command.id); add(reply,'ai'); activeCommandId=''; await refreshFiles(); setState('回复完成'); } } else if(command.status==='failed'){ if(!shownCommands.has(command.id)){ shownCommands.add(command.id); add(command.error||'远程任务失败','sys err'); } activeCommandId=''; setState('任务失败',true); } else { stateEl.textContent='处理中'; statusEl.textContent='桌面端正在处理任务...'; } } }
    async function refreshFiles(){ if(!sessionId) return; const data=await api('/api/remote/relay/sessions/'+encodeURIComponent(sessionId)+'/files'); filesEl.textContent=''; for(const file of data.files||[]){ const a=document.createElement('a'); a.className='file'; a.href=file.download_url; a.target='_blank'; a.rel='noreferrer'; a.download=file.name||''; const n=document.createElement('span'); n.textContent=file.name||'download'; const m=document.createElement('span'); m.textContent=(file.large_file?'局域网 ':'')+size(file.size); a.append(n,m); filesEl.appendChild(a); } }
    form.addEventListener('submit', async (e)=>{ e.preventDefault(); const text=textEl.value.trim(); if(!text||!sessionId) return; sendEl.disabled=true; add(text,'me'); textEl.value=''; try{ await sendMessage(text); setState('已发送，等待桌面端回复'); }catch(err){ add(err.message||'发送失败','sys err'); setState('发送失败',true); activeCommandId=''; } finally{ sendEl.disabled=false; } });
    connect().then(()=>{ polling=setInterval(()=>{ refreshCommands().catch(()=>{}); refreshFiles().catch(()=>{}); },2500); if(polling.unref) polling.unref(); }).catch(err=>{ setState(err.message||'连接失败',true); sendEl.disabled=true; });
  </script>
</body>
</html>"###.replace("__INITIAL_CODE__", &initial_code).replace("__API_BASE_JSON__", &api_base_json)
}

#[allow(dead_code)]
fn remote_page_html(code: Option<&str>) -> String {
    let initial_code = html_escape(&code.map(sanitize_code).unwrap_or_default());
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>智界助手远程连接</title>
  <style>
    :root {{
      color-scheme: light dark;
      --bg: #f7f4ed;
      --panel: #fffdf8;
      --text: #20241f;
      --muted: #72786e;
      --line: rgba(58,88,75,.18);
      --accent: #2f7a59;
      --danger: #b94a42;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --bg: #0f1210;
        --panel: #161a17;
        --text: #ece9de;
        --muted: #a9ad9e;
        --line: rgba(198,211,185,.16);
        --accent: #9ab77d;
        --danger: #e06a61;
      }}
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      background: linear-gradient(180deg, var(--panel), var(--bg));
    }}
    main {{
      width: min(760px, 100%);
      margin: 0 auto;
      padding: 28px 16px;
    }}
    h1 {{
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.25;
    }}
    p {{
      margin: 0;
      color: var(--muted);
      line-height: 1.6;
    }}
    .panel {{
      margin-top: 18px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel) 88%, transparent);
      box-shadow: 0 12px 32px rgba(50,45,31,.08);
    }}
    label {{
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 13px;
    }}
    input, textarea {{
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: transparent;
      font: inherit;
    }}
    input {{
      height: 42px;
      padding: 0 11px;
      text-transform: uppercase;
      letter-spacing: 0;
    }}
    textarea {{
      min-height: 132px;
      padding: 11px;
      line-height: 1.55;
      resize: vertical;
    }}
    button {{
      min-height: 38px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: transparent;
      cursor: pointer;
      font: inherit;
      font-weight: 650;
    }}
    button.primary {{
      border-color: transparent;
      color: #fff;
      background: var(--accent);
    }}
    button:disabled {{
      cursor: default;
      opacity: .55;
    }}
    .row {{
      display: flex;
      gap: 10px;
      align-items: center;
    }}
    .row > * {{ flex: 1 1 auto; }}
    .row > button {{ flex: 0 0 auto; }}
    .machine {{
      display: none;
      gap: 8px;
      margin-top: 14px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }}
    .machine strong {{
      color: var(--text);
    }}
    .status {{
      min-height: 22px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }}
    .status.error {{ color: var(--danger); }}
    .commands {{
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 12px;
    }}
    .command {{
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }}
    .command strong {{ color: var(--text); }}
    @media (max-width: 560px) {{
      main {{ padding: 20px 12px; }}
      .row {{ flex-direction: column; align-items: stretch; }}
      .row > button {{ width: 100%; }}
    }}
  </style>
</head>
<body>
  <main>
    <h1>智界助手远程连接</h1>
    <p>使用桌面助手侧边栏的连接码或二维码连接这台电脑，然后在网页端发送任务。</p>

    <section class="panel">
      <label for="token">登录凭证</label>
      <div class="row">
        <input id="token" type="password" autocomplete="current-password" placeholder="粘贴你的会员 Token" />
        <button id="saveToken">保存</button>
      </div>
      <div class="status" id="authStatus">浏览器会把 Token 保存在本机 localStorage。</div>
    </section>

    <section class="panel">
      <label for="code">连接码</label>
      <div class="row">
        <input id="code" value="{initial_code}" maxlength="16" placeholder="例如 ABC23456" />
        <button id="connect" class="primary">连接</button>
      </div>
      <div class="machine" id="machine"></div>
      <div class="status" id="connectStatus"></div>
    </section>

    <section class="panel">
      <label for="message">远程任务</label>
      <textarea id="message" placeholder="例如：帮我在电脑上整理下载目录，并列出大文件。"></textarea>
      <div class="row" style="margin-top:10px">
        <button id="send" class="primary" disabled>发送到电脑</button>
        <button id="refresh" disabled>刷新状态</button>
      </div>
      <div class="status" id="sendStatus"></div>
      <div class="commands" id="commands"></div>
    </section>
  </main>
  <script>
    const tokenEl = document.getElementById('token');
    const saveTokenEl = document.getElementById('saveToken');
    const authStatusEl = document.getElementById('authStatus');
    const codeEl = document.getElementById('code');
    const connectEl = document.getElementById('connect');
    const connectStatusEl = document.getElementById('connectStatus');
    const machineEl = document.getElementById('machine');
    const messageEl = document.getElementById('message');
    const sendEl = document.getElementById('send');
    const refreshEl = document.getElementById('refresh');
    const sendStatusEl = document.getElementById('sendStatus');
    const commandsEl = document.getElementById('commands');

    let machineId = '';
    let pollTimer = null;
    tokenEl.value = localStorage.getItem('deskagent.remote.token') || '';

    function token() {{
      return tokenEl.value.trim();
    }}

    function setStatus(el, text, error = false) {{
      el.textContent = text || '';
      el.classList.toggle('error', !!error);
    }}

    async function api(path, options = {{}}) {{
      const headers = {{ 'Content-Type': 'application/json' }};
      if (token()) headers.Authorization = 'Bearer ' + token();
      const res = await fetch(path, {{
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      }});
      const data = await res.json().catch(() => ({{}}));
      if (!res.ok) {{
        throw new Error((data.error && data.error.message) || '请求失败 (' + res.status + ')');
      }}
      return data;
    }}

    saveTokenEl.addEventListener('click', () => {{
      localStorage.setItem('deskagent.remote.token', token());
      setStatus(authStatusEl, '已保存。');
    }});

    connectEl.addEventListener('click', connect);
    sendEl.addEventListener('click', sendMessage);
    refreshEl.addEventListener('click', refreshCommands);

    async function connect() {{
      const code = codeEl.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
      codeEl.value = code;
      if (!token()) return setStatus(connectStatusEl, '请先填写登录凭证。', true);
      if (!code) return setStatus(connectStatusEl, '请输入连接码。', true);
      connectEl.disabled = true;
      try {{
        setStatus(connectStatusEl, '正在连接...');
        const info = await api('/api/remote/pairings/' + encodeURIComponent(code), {{ method: 'POST' }});
        machineId = info.machine_id;
        machineEl.style.display = 'grid';
        machineEl.innerHTML = '<div>已连接：<strong>' + machineId.slice(0, 12) + '</strong></div>';
        sendEl.disabled = false;
        refreshEl.disabled = false;
        setStatus(connectStatusEl, '连接成功。');
        await refreshCommands();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(refreshCommands, 3000);
      }} catch (error) {{
        setStatus(connectStatusEl, error.message, true);
      }} finally {{
        connectEl.disabled = false;
      }}
    }}

    async function sendMessage() {{
      const text = messageEl.value.trim();
      if (!machineId) return setStatus(sendStatusEl, '请先连接电脑。', true);
      if (!text) return setStatus(sendStatusEl, '请输入任务。', true);
      sendEl.disabled = true;
      try {{
        const created = await api('/api/remote/machines/' + encodeURIComponent(machineId) + '/commands', {{
          method: 'POST',
          body: {{ command_type: 'chat_message', payload: {{ text }} }},
        }});
        messageEl.value = '';
        setStatus(sendStatusEl, '已发送：' + created.command_id.slice(0, 8));
        await refreshCommands();
      }} catch (error) {{
        setStatus(sendStatusEl, error.message, true);
      }} finally {{
        sendEl.disabled = false;
      }}
    }}

    async function refreshCommands() {{
      if (!machineId) return;
      try {{
        const data = await api('/api/remote/machines/' + encodeURIComponent(machineId) + '/commands');
        commandsEl.innerHTML = '';
        for (const command of (data.commands || []).slice(0, 10)) {{
          const div = document.createElement('div');
          div.className = 'command';
          const text = command.payload && (command.payload.text || command.payload.prompt) || '';
          div.innerHTML =
            '<strong>' + command.status + '</strong> · ' + command.id.slice(0, 8) +
            '<br>' + escapeHtml(text || command.command_type) +
            (command.error ? '<br><span style="color:var(--danger)">' + escapeHtml(command.error) + '</span>' : '');
          commandsEl.appendChild(div);
        }}
      }} catch (error) {{
        setStatus(sendStatusEl, error.message, true);
      }}
    }}

    function escapeHtml(value) {{
      return String(value).replace(/[&<>"']/g, (ch) => ({{
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }}[ch]));
    }}

    if (codeEl.value && token()) {{
      connect();
    }}
  </script>
</body>
</html>"#
    )
}
