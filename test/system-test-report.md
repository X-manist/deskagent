# DeskAgent System Test Report

Date: 2026-05-31

## Scope

This round focused on the one-click desktop assistant path:

- member-authenticated relay usage
- bundled skills/config installation
- first login / first conversation readiness
- built-in desktop MCP bridge tools
- backend membership, package, metering, and refund behavior
- multi-turn task-boundary regression around mail, mail search, and WeChat

## Fixes Applied

1. First conversation activation
   - Fixed the renderer so the first `chat:threadChanged` event selects the runtime-created thread when no active conversation exists.
   - Files:
     - `app/src/renderer/renderer.js`
     - `app/renderer.js` legacy mirror

2. Live task-boundary regression coverage
   - Added `test/live-relay-task-boundary-e2e.js`.
   - The script is opt-in via `LIVE_BOUNDARY_E2E_ALLOW=1` because it consumes real relay tokens.
   - It uses the configured relay/model from `.env`, but captures SMTP and WeChat side effects locally.

3. Local backend unavailable fallback
   - Fixed the desktop startup path that could become "ready" while routing model calls to an unavailable local member backend.
   - If `DESKAGENT_BACKEND_URL` points at localhost, `/health` is unavailable, and `.env` has direct relay settings, the app now starts in development fallback mode and talks directly to the configured relay.
   - Remote/non-local backend failures still fail closed so production membership metering is not bypassed.

4. Stale thread recovery
   - Fixed `thread not found` during send after runtime restart or stale frontend session state.
   - `Engine.send()` now creates a fresh thread and retries once when the app-server rejects the supplied thread ID as missing.
   - The renderer switches to the recovered thread and clears the stale thread busy state.

## Verified

### Static Checks

Command:

```bash
node --check app/src/renderer/renderer.js
node --check app/renderer.js
node --check app/src/main/engine.js
node --check app/src/main/index.js
node --check app/src/main/bridge.js
node --check test/mcp-approval-e2e.js
node --check test/bridge-tools-e2e.js
node --check test/system-api-e2e.js
node --check test/live-relay-task-boundary-e2e.js
```

Result: pass.

### Desktop Bridge Tools

Command:

```bash
node test/bridge-tools-e2e.js
```

Result: pass.

Covered:

- bridge auth and notify
- open URL and desktop open-url action
- screenshot path guard
- local SMTP send capture
- missing IMAP config error
- fake WeChat bridge send/read
- schedule create/list/delete
- MCP tool listing and tool call

### Backend / Gateway / Metering

Command:

```bash
node test/system-api-e2e.js
```

Result: pass.

Covered:

- admin login and auth guard
- admin stats, users, orders, packages, audit
- package create/update and public visibility
- mock SMS login
- manual payment idempotent grant
- gateway streaming metering
- upstream failure refund

### Backend Fallback Guard

Command:

```bash
node test/backend-fallback-unit.js
```

Result: pass.

Covered:

- localhost backend fallback exists
- direct relay settings are required
- fallback can be disabled with `DESKAGENT_DIRECT_RELAY_FALLBACK=false`
- non-local backend failures fail closed
- backend probe happens before `Engine` construction

### Stale Thread Recovery

Command:

```bash
node test/thread-recovery-e2e.js
```

Result: pass.

Evidence:

- stale thread sent: `019e7c73-caea-75f3-841f-2591422cad77`
- engine created a fresh thread
- `threadChanged` included `{ recovered: true, staleThreadId: ... }`
- upstream received exactly one request, from the recovered fresh-thread send
- `thread not found` did not surface to `turnError`

### MCP Approval Regression

Command:

```bash
node test/mcp-approval-e2e.js
```

Result: pass.

Evidence:

- advertised tool namespace: `mcp__deskagent`
- MCP activity:
  - `deskagent.deskagent_notify` started
  - `deskagent.deskagent_notify` completed with `{ "ok": true }`
- no approval/server request was emitted
- bridge was hit

Conclusion: with `default_tools_approval_mode = "approve"` on the bundled `deskagent` MCP server, `approval_policy = "never"` no longer causes the runtime to return `user rejected MCP tool call` for first-party desktop tools.

### Live Relay Task Boundary

Command:

```bash
LIVE_BOUNDARY_E2E_ALLOW=1 node test/live-relay-task-boundary-e2e.js
```

Result: pass.

Live configuration used:

- relay base: `https://llmapi.debinxiang.top/v1`
- model reported by runtime settings: `test-relay-model`

Scenario:

1. Ask to send a test email.
2. Ask to check mail for "test".
3. Ask only: `给文件传输助手发一句：桌面助手微信测试。只处理这一件事，不要处理前面的邮件或查邮。`

Evidence:

- first email was captured by local fake SMTP
- final turn tool calls contained only `deskagent.deskagent_send_wechat_message`
- final turn did not call `deskagent_send_email` or `deskagent_read_email`
- fake SMTP message count stayed at 1
- fake WeChat bridge received exactly one `/send` call:
  - `to`: `文件传输助手`
  - `text`: `桌面助手微信测试`

Conclusion: the task-boundary prompt and runtime/tool path now handle this valuable multi-turn input correctly in the live relay path.

## Notes

- `.env` values were not printed or stored in this report.
- The live boundary test starts local fake SMTP/WeChat servers to avoid sending real external mail or WeChat messages.
- The live test is intentionally opt-in to avoid accidental token usage.
