use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ToolRequest {
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default, alias = "name")]
    pub app: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub shortcut: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default, alias = "outputPath")]
    pub output_path: Option<String>,
    #[serde(default, alias = "workspaceRoot")]
    pub workspace_root: Option<String>,
    #[serde(default, alias = "dryRun")]
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolResponse {
    pub ok: bool,
    pub backend: &'static str,
    pub platform: &'static str,
    pub command: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl ToolResponse {
    fn new(command: &'static str) -> Self {
        Self {
            ok: true,
            backend: "rust-os-tools",
            platform: std::env::consts::OS,
            command,
            action: None,
            path: None,
            message: None,
            details: None,
        }
    }

    fn action(command: &'static str, action: impl Into<String>) -> Self {
        let mut response = Self::new(command);
        response.action = Some(action.into());
        response
    }
}

pub fn probe() -> Result<ToolResponse, String> {
    let mut response = ToolResponse::new("probe");
    response.details = Some(json!({
        "supports": [
            "open-app",
            "open-url",
            "activate-app",
            "type-text",
            "shortcut",
            "click",
            "double-click",
            "move-mouse",
            "scroll",
            "screenshot"
        ],
        "dryRun": true
    }));
    Ok(response)
}

pub fn run_action(request: ToolRequest) -> Result<ToolResponse, String> {
    let action = request
        .action
        .as_deref()
        .ok_or_else(|| "missing action".to_string())?;
    match action {
        "probe" => probe(),
        "open-app" => open_app(request),
        "open-url" => open_url(request),
        "screenshot" => take_screenshot(request),
        "activate-app" => activate_app(request),
        "type-text" => type_text(request),
        "shortcut" => shortcut(request),
        "click" => mouse(request, false, true),
        "double-click" => mouse(request, true, true),
        "move-mouse" => mouse(request, false, false),
        "scroll" => scroll(request),
        other => Err(format!("unsupported action: {other}")),
    }
}

pub fn open_app(request: ToolRequest) -> Result<ToolResponse, String> {
    let app = required(request.app.as_deref(), "missing app/name")?;
    if request.dry_run {
        return Ok(dry_run_response("open-app", json!({ "app": app })));
    }
    #[cfg(target_os = "macos")]
    run_status("open", &["-a", app])?;
    #[cfg(target_os = "windows")]
    run_status("cmd", &["/C", "start", "", app])?;
    #[cfg(all(unix, not(target_os = "macos")))]
    run_status(app, &[])?;
    Ok(ToolResponse::action("open-app", "open-app"))
}

pub fn open_url(request: ToolRequest) -> Result<ToolResponse, String> {
    let url = required(
        request.url.as_deref().or(request.text.as_deref()),
        "missing url/text",
    )?;
    if request.dry_run {
        return Ok(dry_run_response("open-url", json!({ "url": url })));
    }
    #[cfg(target_os = "macos")]
    run_status("open", &[url])?;
    #[cfg(target_os = "windows")]
    run_status("cmd", &["/C", "start", "", url])?;
    #[cfg(all(unix, not(target_os = "macos")))]
    run_status("xdg-open", &[url])?;
    Ok(ToolResponse::action("open-url", "open-url"))
}

pub fn take_screenshot(request: ToolRequest) -> Result<ToolResponse, String> {
    let output = screenshot_path(&request)?;
    if request.dry_run {
        let mut response = dry_run_response("screenshot", json!({ "path": output }));
        response.path = Some(output.to_string_lossy().to_string());
        return Ok(response);
    }
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create screenshot dir: {error}"))?;
    }
    let output_s = output.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    run_status("screencapture", &["-x", &output_s])?;
    #[cfg(target_os = "windows")]
    run_powershell(&windows_screenshot_script(&output_s))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if command_exists("gnome-screenshot") {
            run_status("gnome-screenshot", &["-f", &output_s])?;
        } else if command_exists("import") {
            run_status("import", &["-window", "root", &output_s])?;
        } else {
            return Err(
                "missing screenshot tool: install gnome-screenshot or ImageMagick".to_string(),
            );
        }
    }
    let mut response = ToolResponse::action("screenshot", "screenshot");
    response.path = Some(output_s);
    Ok(response)
}

fn activate_app(request: ToolRequest) -> Result<ToolResponse, String> {
    let app = required(request.app.as_deref(), "missing app/name")?;
    if request.dry_run {
        return Ok(dry_run_response(
            "action",
            json!({ "action": "activate-app", "app": app }),
        ));
    }
    #[cfg(target_os = "macos")]
    run_osascript(&[format!(
        "tell application {} to activate",
        apple_string(app)
    )])?;
    #[cfg(target_os = "windows")]
    run_powershell(&format!("Start-Process {}", ps_quote(app)))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    run_status(app, &[])?;
    Ok(ToolResponse::action("action", "activate-app"))
}

fn type_text(request: ToolRequest) -> Result<ToolResponse, String> {
    let text = request.text.unwrap_or_default();
    if request.dry_run {
        return Ok(dry_run_response(
            "action",
            json!({ "action": "type-text", "chars": text.chars().count() }),
        ));
    }
    #[cfg(target_os = "macos")]
    run_osascript(&[
        "try".to_string(),
        "  set oldClip to the clipboard as text".to_string(),
        "on error".to_string(),
        "  set oldClip to \"\"".to_string(),
        "end try".to_string(),
        format!("set the clipboard to {}", apple_string(&text)),
        "delay 0.08".to_string(),
        "tell application \"System Events\" to keystroke \"v\" using command down".to_string(),
        "delay 0.25".to_string(),
        "set the clipboard to oldClip".to_string(),
    ])?;
    #[cfg(target_os = "windows")]
    run_powershell(&format!(
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait({})",
        ps_quote(&text)
    ))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    run_status("xdotool", &["type", "--delay", "1", &text])?;
    Ok(ToolResponse::action("action", "type-text"))
}

fn shortcut(request: ToolRequest) -> Result<ToolResponse, String> {
    let shortcut = required(request.shortcut.as_deref(), "missing shortcut")?;
    if request.dry_run {
        return Ok(dry_run_response(
            "action",
            json!({ "action": "shortcut", "shortcut": shortcut }),
        ));
    }
    #[cfg(target_os = "macos")]
    run_osascript(&[mac_shortcut_script(shortcut)])?;
    #[cfg(target_os = "windows")]
    run_powershell(&format!(
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait({})",
        ps_quote(&windows_send_keys(shortcut))
    ))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    run_status("xdotool", &["key", shortcut])?;
    Ok(ToolResponse::action("action", "shortcut"))
}

fn mouse(request: ToolRequest, double_click: bool, click: bool) -> Result<ToolResponse, String> {
    let x = request.x.unwrap_or(0.0);
    let y = request.y.unwrap_or(0.0);
    let button = request.button.as_deref().unwrap_or("left");
    let action = if !click {
        "move-mouse"
    } else if double_click {
        "double-click"
    } else {
        "click"
    };
    if request.dry_run {
        return Ok(dry_run_response(
            "action",
            json!({ "action": action, "x": x, "y": y, "button": button }),
        ));
    }
    #[cfg(target_os = "macos")]
    run_jxa(&mac_mouse_script(
        x,
        y,
        button,
        if click {
            if double_click {
                2
            } else {
                1
            }
        } else {
            0
        },
    ))?;
    #[cfg(target_os = "windows")]
    run_powershell(&windows_mouse_script(x, y, button, double_click, click))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        run_status("xdotool", &["mousemove", &coord(x), &coord(y)])?;
        if click {
            if double_click {
                run_status("xdotool", &["click", "--repeat", "2", linux_button(button)])?;
            } else {
                run_status("xdotool", &["click", linux_button(button)])?;
            }
        }
    }
    Ok(ToolResponse::action("action", action))
}

fn scroll(request: ToolRequest) -> Result<ToolResponse, String> {
    let amount = request.amount.unwrap_or(5.0);
    if request.dry_run {
        return Ok(dry_run_response(
            "action",
            json!({ "action": "scroll", "amount": amount }),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        run_jxa(&mac_scroll_script(amount))?;
    }
    #[cfg(target_os = "windows")]
    {
        let key = if amount < 0.0 { "{PGDN}" } else { "{PGUP}" };
        run_powershell(&format!(
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{}')",
            key
        ))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let click = if amount < 0.0 { "5" } else { "4" };
        let count = amount.abs().clamp(1.0, 30.0).round().to_string();
        run_status("xdotool", &["click", "--repeat", &count, click])?;
    }
    Ok(ToolResponse::action("action", "scroll"))
}

fn dry_run_response(command: &'static str, details: Value) -> ToolResponse {
    let mut response = ToolResponse::new(command);
    response.message = Some("dry-run: no OS side effect executed".to_string());
    response.details = Some(details);
    response
}

fn required<'a>(value: Option<&'a str>, message: &str) -> Result<&'a str, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| message.to_string())
}

fn run_status(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("failed to run {program}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("{program} exited with {}", output.status)
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_osascript(lines: &[String]) -> Result<(), String> {
    let script = lines.join("\n");
    run_status("osascript", &["-e", &script])
}

#[cfg(target_os = "macos")]
fn run_jxa(script: &str) -> Result<(), String> {
    run_status("osascript", &["-l", "JavaScript", "-e", script])
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<(), String> {
    run_status("powershell", &["-NoProfile", "-STA", "-Command", script])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn command_exists(command: &str) -> bool {
    Command::new("sh")
        .args(["-lc", &format!("command -v {}", shell_token(command))])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn screenshot_path(request: &ToolRequest) -> Result<PathBuf, String> {
    let workspace = request
        .workspace_root
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or(
            std::env::current_dir().map_err(|error| format!("failed to read cwd: {error}"))?,
        );
    let workspace = normalize_path(&workspace);
    let output = if let Some(path) = request
        .output_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            workspace.join(path)
        }
    } else {
        workspace
            .join("screenshots")
            .join(format!("screen-{}.png", unix_millis()?))
    };
    let output = normalize_path(&output);
    if output != workspace && !output.starts_with(&workspace) {
        return Err("screenshot output must stay inside workspace".to_string());
    }
    Ok(output)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::Prefix(_) => out.push(component.as_os_str()),
        }
    }
    out
}

fn unix_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| format!("system clock before UNIX_EPOCH: {error}"))
}

#[cfg(target_os = "macos")]
fn apple_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization should not fail")
}

#[cfg(target_os = "macos")]
fn mac_shortcut_script(shortcut: &str) -> String {
    let mut parts: Vec<String> = shortcut
        .split('+')
        .map(|part| part.trim().to_lowercase())
        .filter(|part| !part.is_empty())
        .collect();
    let key = parts.pop().unwrap_or_default();
    let mut mods = Vec::new();
    if parts
        .iter()
        .any(|part| matches!(part.as_str(), "command" | "cmd" | "meta"))
    {
        mods.push("command down");
    }
    if parts.iter().any(|part| part == "shift") {
        mods.push("shift down");
    }
    if parts
        .iter()
        .any(|part| matches!(part.as_str(), "option" | "alt"))
    {
        mods.push("option down");
    }
    if parts
        .iter()
        .any(|part| matches!(part.as_str(), "control" | "ctrl"))
    {
        mods.push("control down");
    }
    let suffix = if mods.is_empty() {
        String::new()
    } else {
        format!(" using {{{}}}", mods.join(", "))
    };
    match key.as_str() {
        "enter" | "return" => format!("tell application \"System Events\" to key code 36{suffix}"),
        "tab" => format!("tell application \"System Events\" to key code 48{suffix}"),
        "escape" | "esc" => format!("tell application \"System Events\" to key code 53{suffix}"),
        other => format!(
            "tell application \"System Events\" to keystroke {}{}",
            apple_string(other),
            suffix
        ),
    }
}

#[cfg(target_os = "macos")]
fn mac_mouse_script(x: f64, y: f64, button: &str, repeat: u8) -> String {
    let (btn, down, up) = match button {
        "right" => (1, 3, 4),
        "middle" => (2, 25, 26),
        _ => (0, 1, 2),
    };
    let mut lines = vec![
        "ObjC.import('CoreGraphics');".to_string(),
        format!("var pt = $.CGPointMake({}, {});", x.round(), y.round()),
        format!("$.CGEventPost(0, $.CGEventCreateMouseEvent($(), 5, pt, {btn}));"),
    ];
    if repeat > 0 {
        lines.push("delay(0.05);".to_string());
        lines.push(format!("for (var i = 0; i < {}; i++) {{", repeat.min(3)));
        lines.push(format!(
            "  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), {down}, pt, {btn}));"
        ));
        lines.push(format!(
            "  $.CGEventPost(0, $.CGEventCreateMouseEvent($(), {up}, pt, {btn}));"
        ));
        lines.push("  delay(0.08);".to_string());
        lines.push("}".to_string());
    }
    lines.push("'OK';".to_string());
    lines.join("\n")
}

#[cfg(target_os = "macos")]
fn mac_scroll_script(amount: f64) -> String {
    let lines = amount.clamp(-30.0, 30.0).round() as i64;
    [
        "ObjC.import('CoreGraphics');".to_string(),
        format!("var event = $.CGEventCreateScrollWheelEvent($(), 1, 1, {});", lines),
        "$.CGEventPost(0, event);".to_string(),
        "'OK';".to_string(),
    ]
    .join("\n")
}

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn windows_send_keys(shortcut: &str) -> String {
    shortcut
        .split('+')
        .map(|part| part.trim().to_lowercase())
        .map(|key| match key.as_str() {
            "ctrl" | "control" => "^".to_string(),
            "alt" => "%".to_string(),
            "shift" => "+".to_string(),
            "meta" | "win" | "command" => "#".to_string(),
            "enter" | "return" => "{ENTER}".to_string(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("")
}

#[cfg(target_os = "windows")]
fn windows_mouse_script(x: f64, y: f64, button: &str, double_click: bool, click: bool) -> String {
    let (down, up) = match button {
        "right" => (0x0008, 0x0010),
        "middle" => (0x0020, 0x0040),
        _ => (0x0002, 0x0004),
    };
    let repeat = if click && double_click {
        2
    } else if click {
        1
    } else {
        0
    };
    let mut lines = vec![
        "Add-Type -AssemblyName System.Windows.Forms".to_string(),
        "$sig = '[DllImport(\"user32.dll\")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);'".to_string(),
        "Add-Type -MemberDefinition $sig -Name U32 -Namespace Win32".to_string(),
        format!("[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point({}, {})", x.round(), y.round()),
    ];
    for _ in 0..repeat {
        lines.push(format!(
            "[Win32.U32]::mouse_event({down}, 0, 0, 0, [UIntPtr]::Zero)"
        ));
        lines.push(format!(
            "[Win32.U32]::mouse_event({up}, 0, 0, 0, [UIntPtr]::Zero)"
        ));
    }
    lines.join("; ")
}

#[cfg(target_os = "windows")]
fn windows_screenshot_script(path: &str) -> String {
    [
        "Add-Type -AssemblyName System.Windows.Forms".to_string(),
        "Add-Type -AssemblyName System.Drawing".to_string(),
        "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds".to_string(),
        "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height".to_string(),
        "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)".to_string(),
        "$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)"
            .to_string(),
        format!(
            "$bitmap.Save({}, [System.Drawing.Imaging.ImageFormat]::Png)",
            ps_quote(path)
        ),
        "$graphics.Dispose()".to_string(),
        "$bitmap.Dispose()".to_string(),
    ]
    .join("; ")
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn shell_token(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_button(button: &str) -> &'static str {
    match button {
        "right" => "3",
        "middle" => "2",
        _ => "1",
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn coord(value: f64) -> String {
    value.round().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_capabilities() {
        let response = probe().expect("probe should work");
        assert!(response.ok);
        assert_eq!(response.backend, "rust-os-tools");
        let details = response.details.expect("details");
        assert!(details["supports"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "click"));
    }

    #[test]
    fn screenshot_path_rejects_escape() {
        let req = ToolRequest {
            output_path: Some("../outside.png".to_string()),
            workspace_root: Some("/tmp/deskagent-workspace".to_string()),
            ..ToolRequest::default()
        };
        assert!(screenshot_path(&req).is_err());
    }

    #[test]
    fn screenshot_path_accepts_workspace_relative_path() {
        let req = ToolRequest {
            output_path: Some("shots/inside.png".to_string()),
            workspace_root: Some("/tmp/deskagent-workspace".to_string()),
            ..ToolRequest::default()
        };
        let path = screenshot_path(&req).expect("inside workspace");
        assert_eq!(
            path,
            PathBuf::from("/tmp/deskagent-workspace/shots/inside.png")
        );
    }

    #[test]
    fn windows_shortcut_mapping_is_stable() {
        assert_eq!(windows_send_keys("ctrl+shift+enter"), "^+{ENTER}");
        assert_eq!(windows_send_keys("command+k"), "#k");
    }

    #[test]
    fn dry_run_type_text_has_no_side_effect() {
        let response = run_action(ToolRequest {
            action: Some("type-text".to_string()),
            text: Some("hello".to_string()),
            dry_run: true,
            ..ToolRequest::default()
        })
        .expect("dry run");
        assert_eq!(response.backend, "rust-os-tools");
        assert!(response.message.unwrap().contains("dry-run"));
    }
}
