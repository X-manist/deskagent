use axum::extract::Query;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Html;
use axum::routing::{get, post};
use axum::{Json, Router};
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
            "/api/remote/pairings/{code}",
            get(read_pairing).post(consume_pairing),
        )
        .route("/api/remote/machine/heartbeat", post(machine_heartbeat))
        .route("/api/remote/machine/commands", get(machine_poll_commands))
        .route(
            "/api/remote/machine/commands/{command_id}/result",
            post(machine_command_result),
        )
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
    format!("{scheme}://{host}")
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
                "SELECT 1 FROM remote_pairings WHERE code = ? AND consumed_at IS NULL AND expires_at > datetime('now')",
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
    let expires_at = (Utc::now() + Duration::minutes(10)).to_rfc3339();
    let app_url = req
        .app_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| format!("deskagent://connect?code={code}"));
    let web_url = req
        .web_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| format!("{}/remote?code={code}", public_server_url(&headers)));
    let payload = json!({
        "version": 1,
        "product": "deskagent",
        "code": code,
        "machine_id": machine_id,
        "server_url": public_server_url(&headers),
        "app_url": app_url,
        "web_url": web_url,
    });

    sqlx::query(
        "INSERT INTO remote_pairings (id, code, user_id, machine_id, payload_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&pairing_id)
    .bind(&code)
    .bind(user.0.sub)
    .bind(&machine_id)
    .bind(payload.to_string())
    .bind(&expires_at)
    .execute(&st.db)
    .await?;

    Ok(Json(json!({
        "pairing_id": pairing_id,
        "code": code,
        "expires_at": expires_at,
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
         WHERE p.code = ? AND p.user_id = ? AND p.consumed_at IS NULL AND p.expires_at > datetime('now')",
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
         WHERE p.code = ? AND p.user_id = ? AND p.consumed_at IS NULL AND p.expires_at > datetime('now')",
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
    Ok(Json(json!({ "ok": true, "machine_id": machine_id })))
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
struct RemotePageQuery {
    #[serde(default)]
    code: Option<String>,
}

async fn remote_web_page(Query(q): Query<RemotePageQuery>) -> Html<String> {
    Html(remote_page_html_modern(q.code.as_deref()))
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn remote_page_html_modern(code: Option<&str>) -> String {
    let initial_code = html_escape(&code.map(sanitize_code).unwrap_or_default());
    r###"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>智界助手远程连接</title>
  <link rel="icon" href="data:," />
  <script>
    (function () {
      var key = 'deskagent.themeMode';
      var mode = localStorage.getItem(key) || 'auto';
      function autoTheme() {
        var hour = new Date().getHours();
        if (hour >= 22 || hour < 7) return 'dark';
        if (hour >= 18) return 'eye';
        return 'light';
      }
      document.documentElement.dataset.themeMode = mode;
      document.documentElement.dataset.theme = mode === 'auto' ? autoTheme() : mode;
    })();
  </script>
  <style>
    :root {
      color-scheme: light;
      --font-sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
      --font-mono: "SF Mono", Menlo, Consolas, monospace;
      --bg: #f7f4ed;
      --paper: rgba(255, 253, 247, 0.9);
      --paper-strong: #fffdf8;
      --paper-soft: rgba(247, 243, 234, 0.76);
      --line: rgba(58, 88, 75, 0.16);
      --line-strong: rgba(58, 88, 75, 0.28);
      --text: #20241f;
      --muted: #777b72;
      --faint: #a8a99f;
      --accent: #2f7a59;
      --accent-strong: #216447;
      --accent-soft: rgba(47, 122, 89, 0.12);
      --gold: #b39150;
      --danger: #b94a42;
      --ok: #2f8c5b;
      --shadow: 0 20px 46px rgba(67, 57, 35, 0.12);
      --shadow-soft: 0 10px 28px rgba(67, 57, 35, 0.08);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #0f1210;
      --paper: rgba(21, 24, 21, 0.86);
      --paper-strong: #161a17;
      --paper-soft: rgba(28, 32, 29, 0.72);
      --line: rgba(198, 211, 185, 0.13);
      --line-strong: rgba(198, 211, 185, 0.24);
      --text: #ece9de;
      --muted: #a9ad9e;
      --faint: #747a6f;
      --accent: #9ab77d;
      --accent-strong: #c8d7a0;
      --accent-soft: rgba(154, 183, 125, 0.16);
      --gold: #d8b46a;
      --danger: #e06a61;
      --ok: #90c28f;
      --shadow: 0 22px 50px rgba(0, 0, 0, 0.42);
      --shadow-soft: 0 12px 34px rgba(0, 0, 0, 0.28);
    }
    :root[data-theme="eye"] {
      --bg: #f4efd9;
      --paper: rgba(250, 246, 229, 0.9);
      --paper-strong: #fbf7e7;
      --paper-soft: rgba(239, 232, 204, 0.68);
      --line: rgba(95, 105, 64, 0.18);
      --line-strong: rgba(95, 105, 64, 0.32);
      --text: #23281d;
      --muted: #73785f;
      --faint: #9b9b80;
      --accent: #5f8d45;
      --accent-strong: #3f6d31;
      --accent-soft: rgba(95, 141, 69, 0.14);
      --gold: #a77f3e;
      --danger: #aa584a;
      --ok: #4f8d43;
      --shadow: 0 18px 42px rgba(86, 75, 40, 0.13);
      --shadow-soft: 0 10px 26px rgba(86, 75, 40, 0.09);
    }
    * { box-sizing: border-box; }
    html,
    body {
      margin: 0;
      min-height: 100%;
    }
    body {
      position: relative;
      min-width: 320px;
      min-height: 100vh;
      overflow-x: hidden;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 14px;
      letter-spacing: 0;
      background:
        linear-gradient(135deg, rgba(255,255,255,0.34), transparent 34%),
        linear-gradient(180deg, var(--paper-strong), var(--bg));
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(140deg, transparent 0 42%, rgba(47, 122, 89, 0.055) 42% 58%, transparent 58%),
        repeating-linear-gradient(0deg, rgba(94, 83, 53, 0.018), rgba(94, 83, 53, 0.018) 1px, transparent 1px, transparent 18px);
      opacity: 0.82;
    }
    :root[data-theme="dark"] body {
      background:
        linear-gradient(135deg, rgba(211, 183, 111, 0.08), transparent 36%),
        linear-gradient(180deg, #141812, #0e110f);
    }
    :root[data-theme="dark"] body::before {
      background:
        linear-gradient(140deg, transparent 0 42%, rgba(154, 183, 125, 0.055) 42% 58%, transparent 58%),
        repeating-linear-gradient(0deg, rgba(232, 226, 205, 0.018), rgba(232, 226, 205, 0.018) 1px, transparent 1px, transparent 18px);
    }
    button,
    input,
    textarea {
      font: inherit;
    }
    .app {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(256px, 330px) minmax(0, 1fr);
      gap: 18px;
      width: min(1180px, 100%);
      min-height: 100vh;
      margin: 0 auto;
      padding: 18px;
    }
    .sidebar,
    .workspace {
      min-width: 0;
    }
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: calc(100vh - 36px);
      padding: 16px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: linear-gradient(180deg, var(--paper), rgba(246, 242, 231, 0.72));
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(18px);
    }
    :root[data-theme="dark"] .sidebar {
      background: linear-gradient(180deg, rgba(19, 23, 20, 0.92), rgba(12, 15, 13, 0.76));
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      padding: 0 2px 6px;
    }
    .logo {
      display: grid;
      flex: 0 0 38px;
      width: 38px;
      height: 38px;
      place-items: center;
      border: 1px solid var(--line-strong);
      border-radius: 50%;
      color: var(--accent-strong);
      background:
        linear-gradient(135deg, rgba(255,255,255,0.72), rgba(255,255,255,0.12)),
        var(--accent-soft);
      font-size: 19px;
      font-weight: 700;
      box-shadow: inset 0 0 0 3px rgba(255,255,255,0.24);
    }
    .brand-copy {
      min-width: 0;
    }
    .brand-name {
      overflow: hidden;
      font-size: 17px;
      font-weight: 700;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .brand-sub {
      overflow: hidden;
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .theme-switcher {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--paper-soft);
    }
    .theme-btn {
      min-height: 30px;
      padding: 0 6px;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--muted);
      background: transparent;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
    }
    .theme-btn.active {
      border-color: var(--line-strong);
      color: var(--text);
      background: var(--paper-strong);
      box-shadow: var(--shadow-soft);
    }
    :root[data-theme="dark"] .theme-btn.active {
      background: rgba(255,255,255,0.08);
    }
    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 22px;
      margin: 2px 4px 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.2;
    }
    .section-mark {
      width: 34px;
      height: 1px;
      background: var(--line-strong);
    }
    .connection-card,
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--paper);
      box-shadow: var(--shadow-soft);
      backdrop-filter: blur(16px);
    }
    .connection-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      gap: 7px;
      min-height: 28px;
      padding: 5px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--paper-soft);
      font-size: 12px;
      line-height: 1;
    }
    .status-badge::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--faint);
    }
    .status-badge.live::before {
      background: var(--ok);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 18%, transparent);
    }
    .status-badge.error::before {
      background: var(--danger);
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 18%, transparent);
    }
    .pairing-code {
      display: grid;
      min-height: 76px;
      place-items: center;
      border: 1px dashed var(--line-strong);
      border-radius: 8px;
      color: var(--accent-strong);
      background: var(--accent-soft);
      font-family: var(--font-mono);
      font-size: 28px;
      font-weight: 760;
      letter-spacing: 0;
      word-break: break-all;
    }
    .machine {
      display: none;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      background: var(--paper-soft);
      font-size: 13px;
      line-height: 1.25;
    }
    .machine strong {
      color: var(--text);
    }
    .help {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.6;
    }
    .workspace {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: calc(100vh - 36px);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      min-height: 58px;
      padding: 10px 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255,255,255,0.28);
      backdrop-filter: blur(16px);
    }
    :root[data-theme="dark"] .topbar {
      background: rgba(13, 16, 14, 0.72);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
    }
    .topbar p {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }
    .workspace-status {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      text-align: right;
    }
    .panel {
      padding: 16px;
    }
    .panel-lg {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    label {
      display: block;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
    }
    input,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: var(--paper-soft);
      font: inherit;
      outline: none;
    }
    input:focus,
    textarea:focus {
      border-color: color-mix(in srgb, var(--accent) 62%, var(--line));
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    input {
      height: 42px;
      padding: 0 11px;
      letter-spacing: 0;
    }
    #code {
      text-transform: uppercase;
      font-family: var(--font-mono);
      font-weight: 700;
    }
    textarea {
      flex: 1 1 auto;
      min-height: 184px;
      padding: 11px;
      line-height: 1.55;
      resize: vertical;
    }
    button {
      min-height: 40px;
      padding: 0 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: var(--paper-soft);
      cursor: pointer;
      font: inherit;
      font-weight: 650;
    }
    button:hover:not(:disabled) {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    button.primary {
      border-color: rgba(255,255,255,0.18);
      color: #fff;
      background: linear-gradient(135deg, var(--accent), var(--accent-strong));
      box-shadow: var(--shadow-soft);
    }
    :root[data-theme="dark"] button.primary {
      color: #0f1210;
    }
    button:disabled {
      cursor: default;
      opacity: .55;
    }
    .row {
      display: flex;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }
    .row > * {
      flex: 1 1 auto;
      min-width: 0;
    }
    .row > button {
      flex: 0 0 auto;
    }
    .status {
      min-height: 22px;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .status.error {
      color: var(--danger);
    }
    .commands {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 38vh;
      margin-top: 12px;
      overflow: auto;
    }
    .commands:empty::before {
      content: "暂无远程任务";
      display: block;
      padding: 12px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      color: var(--faint);
      font-size: 13px;
    }
    .command {
      padding: 10px 11px;
      overflow-wrap: anywhere;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      background: var(--paper-soft);
      font-size: 13px;
      line-height: 1.45;
    }
    .command strong {
      color: var(--text);
    }
    .command-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
      font-size: 12px;
    }
    .command-error {
      display: block;
      margin-top: 5px;
      color: var(--danger);
    }
    @media (max-width: 860px) {
      .app {
        grid-template-columns: 1fr;
        gap: 12px;
        padding: 12px;
      }
      .sidebar,
      .workspace {
        min-height: auto;
      }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .workspace-status {
        text-align: left;
      }
      .pairing-code {
        min-height: 58px;
        font-size: 22px;
      }
      textarea {
        min-height: 148px;
      }
      .commands {
        max-height: none;
      }
    }
    @media (max-width: 560px) {
      .app {
        padding: 10px;
      }
      .sidebar,
      .panel,
      .topbar {
        padding: 12px;
      }
      .row {
        flex-direction: column;
        align-items: stretch;
      }
      .row > button {
        width: 100%;
      }
      .brand-name {
        font-size: 16px;
      }
      h1 {
        font-size: 18px;
      }
      .theme-btn {
        padding: 0 4px;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <aside class="sidebar">
      <div class="brand">
        <div class="logo">智</div>
        <div class="brand-copy">
          <div class="brand-name">智界助手</div>
          <div class="brand-sub">远程连接</div>
        </div>
      </div>
      <div class="theme-switcher" aria-label="主题切换">
        <button class="theme-btn" type="button" data-theme-mode-value="auto">自动</button>
        <button class="theme-btn" type="button" data-theme-mode-value="light">浅色</button>
        <button class="theme-btn" type="button" data-theme-mode-value="dark">深色</button>
        <button class="theme-btn" type="button" data-theme-mode-value="eye">护眼</button>
      </div>
      <div class="section-title"><span>连接状态</span><span class="section-mark"></span></div>
      <section class="connection-card">
        <div class="status-badge" id="statusBadge">待连接</div>
        <div class="pairing-code" id="pairingCode">--------</div>
        <div class="machine" id="machine"></div>
        <p class="help" id="connectionHelp">输入桌面助手侧边栏中的连接码后，即可把任务发送到这台电脑。</p>
      </section>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <h1>远程任务</h1>
          <p>保持和桌面端一致的会话入口。</p>
        </div>
        <div class="workspace-status" id="workspaceStatus">等待连接</div>
      </header>

      <section class="panel">
        <div class="field">
          <label for="token">登录凭证</label>
          <div class="row">
            <input id="token" type="password" autocomplete="current-password" placeholder="粘贴你的会员 Token" />
            <button id="saveToken" type="button">保存</button>
          </div>
        </div>
        <div class="status" id="authStatus">Token 仅保存在当前浏览器。</div>
      </section>

      <section class="panel">
        <div class="field">
          <label for="code">连接码</label>
          <div class="row">
            <input id="code" value="__INITIAL_CODE__" maxlength="16" placeholder="例如 ABC23456" />
            <button id="connect" class="primary" type="button">连接</button>
          </div>
        </div>
        <div class="status" id="connectStatus"></div>
      </section>

      <section class="panel panel-lg">
        <div class="field" style="flex:1 1 auto">
          <label for="message">远程任务</label>
          <textarea id="message" placeholder="例如：帮我在电脑上整理下载目录，并列出大文件。"></textarea>
        </div>
        <div class="row" style="margin-top:10px">
          <button id="send" class="primary" type="button" disabled>发送到电脑</button>
          <button id="refresh" type="button" disabled>刷新状态</button>
        </div>
        <div class="status" id="sendStatus"></div>
        <div class="commands" id="commands"></div>
      </section>
    </section>
  </main>
  <script>
    const THEME_STORAGE_KEY = 'deskagent.themeMode';
    const tokenEl = document.getElementById('token');
    const saveTokenEl = document.getElementById('saveToken');
    const authStatusEl = document.getElementById('authStatus');
    const codeEl = document.getElementById('code');
    const pairingCodeEl = document.getElementById('pairingCode');
    const connectEl = document.getElementById('connect');
    const connectStatusEl = document.getElementById('connectStatus');
    const statusBadgeEl = document.getElementById('statusBadge');
    const workspaceStatusEl = document.getElementById('workspaceStatus');
    const machineEl = document.getElementById('machine');
    const connectionHelpEl = document.getElementById('connectionHelp');
    const messageEl = document.getElementById('message');
    const sendEl = document.getElementById('send');
    const refreshEl = document.getElementById('refresh');
    const sendStatusEl = document.getElementById('sendStatus');
    const commandsEl = document.getElementById('commands');
    const themeButtons = Array.from(document.querySelectorAll('.theme-btn'));

    let machineId = '';
    let pollTimer = null;
    tokenEl.value = localStorage.getItem('deskagent.remote.token') || '';
    updatePairingCode();
    applyThemeMode(localStorage.getItem(THEME_STORAGE_KEY) || 'auto', false);

    function autoThemeForNow() {
      const hour = new Date().getHours();
      if (hour >= 22 || hour < 7) return 'dark';
      if (hour >= 18) return 'eye';
      return 'light';
    }

    function applyThemeMode(mode, persist = true) {
      const nextMode = ['auto', 'light', 'dark', 'eye'].includes(mode) ? mode : 'auto';
      const theme = nextMode === 'auto' ? autoThemeForNow() : nextMode;
      document.documentElement.dataset.themeMode = nextMode;
      document.documentElement.dataset.theme = theme;
      if (persist) localStorage.setItem(THEME_STORAGE_KEY, nextMode);
      themeButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.themeModeValue === nextMode);
      });
    }

    setInterval(() => {
      if ((localStorage.getItem(THEME_STORAGE_KEY) || 'auto') === 'auto') {
        applyThemeMode('auto', false);
      }
    }, 60000);

    themeButtons.forEach((button) => {
      button.addEventListener('click', () => applyThemeMode(button.dataset.themeModeValue || 'auto'));
    });

    function token() {
      return tokenEl.value.trim();
    }

    function setStatus(el, text, error = false) {
      el.textContent = text || '';
      el.classList.toggle('error', !!error);
    }

    function setBadge(text, type = '') {
      statusBadgeEl.textContent = text;
      statusBadgeEl.classList.toggle('live', type === 'live');
      statusBadgeEl.classList.toggle('error', type === 'error');
    }

    function updatePairingCode() {
      const code = codeEl.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
      pairingCodeEl.textContent = code || '--------';
    }

    async function api(path, options = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (token()) headers.Authorization = 'Bearer ' + token();
      const res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data.error && data.error.message) || '请求失败 (' + res.status + ')');
      }
      return data;
    }

    saveTokenEl.addEventListener('click', () => {
      localStorage.setItem('deskagent.remote.token', token());
      setStatus(authStatusEl, '已保存。');
    });

    codeEl.addEventListener('input', updatePairingCode);
    connectEl.addEventListener('click', connect);
    sendEl.addEventListener('click', sendMessage);
    refreshEl.addEventListener('click', refreshCommands);

    async function connect() {
      const code = codeEl.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
      codeEl.value = code;
      updatePairingCode();
      if (!token()) {
        setBadge('缺少凭证', 'error');
        return setStatus(connectStatusEl, '请先填写登录凭证。', true);
      }
      if (!code) {
        setBadge('缺少连接码', 'error');
        return setStatus(connectStatusEl, '请输入连接码。', true);
      }
      connectEl.disabled = true;
      try {
        setBadge('连接中');
        workspaceStatusEl.textContent = '正在连接电脑';
        setStatus(connectStatusEl, '正在连接...');
        const info = await api('/api/remote/pairings/' + encodeURIComponent(code), { method: 'POST' });
        machineId = info.machine_id;
        machineEl.style.display = 'grid';
        machineEl.textContent = '';
        const machineLine = document.createElement('div');
        machineLine.append('已连接：');
        const strong = document.createElement('strong');
        strong.textContent = machineId.slice(0, 12);
        machineLine.appendChild(strong);
        machineEl.appendChild(machineLine);
        sendEl.disabled = false;
        refreshEl.disabled = false;
        setBadge('已连接', 'live');
        workspaceStatusEl.textContent = '电脑在线，等待任务';
        connectionHelpEl.textContent = '连接已建立，发送的任务会进入桌面端会话。';
        setStatus(connectStatusEl, '连接成功。');
        await refreshCommands();
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(refreshCommands, 3000);
      } catch (error) {
        setBadge('连接失败', 'error');
        workspaceStatusEl.textContent = '连接失败';
        setStatus(connectStatusEl, error.message, true);
      } finally {
        connectEl.disabled = false;
      }
    }

    async function sendMessage() {
      const text = messageEl.value.trim();
      if (!machineId) return setStatus(sendStatusEl, '请先连接电脑。', true);
      if (!text) return setStatus(sendStatusEl, '请输入任务。', true);
      sendEl.disabled = true;
      try {
        const created = await api('/api/remote/machines/' + encodeURIComponent(machineId) + '/commands', {
          method: 'POST',
          body: { command_type: 'chat_message', payload: { text } },
        });
        messageEl.value = '';
        setStatus(sendStatusEl, '已发送：' + created.command_id.slice(0, 8));
        workspaceStatusEl.textContent = '任务已发送，等待桌面端处理';
        await refreshCommands();
      } catch (error) {
        setStatus(sendStatusEl, error.message, true);
      } finally {
        sendEl.disabled = false;
      }
    }

    async function refreshCommands() {
      if (!machineId) return;
      try {
        const data = await api('/api/remote/machines/' + encodeURIComponent(machineId) + '/commands');
        commandsEl.textContent = '';
        for (const command of (data.commands || []).slice(0, 10)) {
          const div = document.createElement('div');
          div.className = 'command';

          const meta = document.createElement('div');
          meta.className = 'command-meta';
          const status = document.createElement('strong');
          status.textContent = command.status || 'unknown';
          const id = document.createElement('span');
          id.textContent = (command.id || '').slice(0, 8);
          meta.append(status, id);

          const text = document.createElement('div');
          const payload = command.payload || {};
          text.textContent = payload.text || payload.prompt || command.command_type || '';

          div.append(meta, text);
          if (command.error) {
            const err = document.createElement('span');
            err.className = 'command-error';
            err.textContent = command.error;
            div.appendChild(err);
          }
          commandsEl.appendChild(div);
        }
      } catch (error) {
        setStatus(sendStatusEl, error.message, true);
      }
    }

    if (codeEl.value && token()) {
      connect();
    }
  </script>
</body>
</html>"###.replace("__INITIAL_CODE__", &initial_code)
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
