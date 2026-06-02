use anyhow::{anyhow, Result};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use std::collections::BTreeMap;

use crate::config::Config;

type HmacSha1 = Hmac<Sha1>;

/// RFC3986 percent-encoding as required by Aliyun RPC signing.
fn percent(s: &str) -> String {
    let enc = urlencoding::encode(s).into_owned();
    enc.replace('+', "%20")
        .replace('*', "%2A")
        .replace("%7E", "~")
}

fn sign(secret: &str, method: &str, params: &BTreeMap<String, String>) -> String {
    let canon = params
        .iter()
        .map(|(k, v)| format!("{}={}", percent(k), percent(v)))
        .collect::<Vec<_>>()
        .join("&");
    let string_to_sign = format!("{}&{}&{}", method, percent("/"), percent(&canon));
    let mut mac = HmacSha1::new_from_slice(format!("{secret}&").as_bytes()).unwrap();
    mac.update(string_to_sign.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

fn common_params(cfg: &Config, action: &str) -> BTreeMap<String, String> {
    let mut p = BTreeMap::new();
    p.insert("Format".into(), "JSON".into());
    p.insert("Version".into(), "2017-05-25".into());
    p.insert("AccessKeyId".into(), cfg.aliyun_ak_id.clone());
    p.insert("SignatureMethod".into(), "HMAC-SHA1".into());
    p.insert("SignatureVersion".into(), "1.0".into());
    p.insert("SignatureNonce".into(), uuid::Uuid::new_v4().to_string());
    p.insert(
        "Timestamp".into(),
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    );
    p.insert("Action".into(), action.into());
    p
}

async fn call(
    cfg: &Config,
    http: &reqwest::Client,
    mut params: BTreeMap<String, String>,
) -> Result<serde_json::Value> {
    let sig = sign(&cfg.aliyun_ak_secret, "GET", &params);
    params.insert("Signature".into(), sig);
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", percent(k), percent(v)))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!("https://{}/?{}", cfg.pnvs_endpoint, query);
    let resp = http.get(&url).send().await?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));
    if !status.is_success() {
        return Err(anyhow!("aliyun http {}: {}", status, body));
    }
    Ok(body)
}

/// Send a verification code. Aliyun generates and stores the code (verified later
/// via CheckSmsVerifyCode). Returns Some(code) only in mock/return-code mode.
pub async fn send_code(
    cfg: &Config,
    http: &reqwest::Client,
    phone: &str,
) -> Result<Option<String>> {
    if cfg.is_mock_sms() {
        let code = cfg.sms_mock_code.clone();
        tracing::info!("[mock-sms] phone={} code={}", phone, code);
        return Ok(Some(code));
    }
    let mut p = common_params(cfg, "SendSmsVerifyCode");
    p.insert("PhoneNumber".into(), phone.into());
    p.insert("SignName".into(), cfg.pnvs_sign_name.clone());
    p.insert("TemplateCode".into(), cfg.pnvs_template_code.clone());
    let ttl_min = (cfg.sms_code_ttl_secs / 60).max(1).to_string();
    let template_param = serde_json::json!({
        cfg.pnvs_code_var.clone(): "##code##",
        cfg.pnvs_ttl_var.clone(): ttl_min,
    });
    p.insert("TemplateParam".into(), template_param.to_string());
    p.insert("CountryCode".into(), cfg.pnvs_country_code.clone());
    p.insert("CodeLength".into(), cfg.sms_code_length.to_string());
    p.insert("ValidTime".into(), cfg.sms_code_ttl_secs.to_string());
    p.insert("DuplicatePolicy".into(), cfg.pnvs_duplicate_policy.clone());
    p.insert("Interval".into(), cfg.sms_cooldown_secs.to_string());
    p.insert("CodeType".into(), cfg.pnvs_code_type.clone());
    p.insert(
        "ReturnVerifyCode".into(),
        cfg.sms_expose_mock_code.to_string(),
    );

    let body = call(cfg, http, p).await?;
    let ok = body.get("Code").and_then(|c| c.as_str()) == Some("OK");
    if !ok {
        return Err(anyhow!("SendSmsVerifyCode failed: {}", body));
    }
    let code = body
        .get("Model")
        .and_then(|m| m.get("VerifyCode"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string());
    Ok(code)
}

/// Verify a code with Aliyun. Returns true if it matches.
pub async fn check_code(
    cfg: &Config,
    http: &reqwest::Client,
    phone: &str,
    code: &str,
) -> Result<bool> {
    if cfg.is_mock_sms() {
        return Ok(code == cfg.sms_mock_code);
    }
    let mut p = common_params(cfg, "CheckSmsVerifyCode");
    p.insert("PhoneNumber".into(), phone.into());
    p.insert("VerifyCode".into(), code.into());
    p.insert("CountryCode".into(), cfg.pnvs_country_code.clone());
    let body = call(cfg, http, p).await?;
    let ok = body.get("Code").and_then(|c| c.as_str()) == Some("OK");
    let pass = body
        .get("Model")
        .and_then(|m| m.get("VerifyResult"))
        .and_then(|c| c.as_str())
        == Some("PASS");
    Ok(ok && pass)
}
