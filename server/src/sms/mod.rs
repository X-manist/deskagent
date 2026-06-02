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

fn insert_if_present(params: &mut BTreeMap<String, String>, key: &str, value: &str) {
    let value = value.trim();
    if !value.is_empty() {
        params.insert(key.to_string(), value.to_string());
    }
}

fn aliyun_endpoint(cfg: &Config) -> String {
    let endpoint = cfg.pnvs_endpoint.trim().trim_end_matches('/');
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        endpoint.to_string()
    } else {
        format!("https://{endpoint}")
    }
}

fn require_aliyun_config(cfg: &Config) -> Result<()> {
    if cfg.aliyun_ak_id.trim().is_empty() || cfg.aliyun_ak_secret.trim().is_empty() {
        return Err(anyhow!("阿里云 AccessKey 未配置"));
    }
    if cfg.pnvs_sign_name.trim().is_empty() {
        return Err(anyhow!("ALIYUN_PNVS_SIGN_NAME 未配置"));
    }
    if cfg.pnvs_template_code.trim().is_empty() {
        return Err(anyhow!("ALIYUN_PNVS_TEMPLATE_CODE 未配置"));
    }
    Ok(())
}

fn aliyun_success(body: &serde_json::Value) -> bool {
    let code_ok = body.get("Code").and_then(|c| c.as_str()) == Some("OK");
    let success = body
        .get("Success")
        .and_then(|s| s.as_bool())
        .unwrap_or(code_ok);
    code_ok && success
}

fn aliyun_error(action: &str, body: &serde_json::Value) -> anyhow::Error {
    let code = body
        .get("Code")
        .and_then(|c| c.as_str())
        .unwrap_or("Unknown");
    let message = body
        .get("Message")
        .and_then(|m| m.as_str())
        .unwrap_or("阿里云接口返回异常");
    let request_id = body.get("RequestId").and_then(|r| r.as_str()).unwrap_or("");
    if request_id.is_empty() {
        anyhow!("{action} failed: {code}: {message}")
    } else {
        anyhow!("{action} failed: {code}: {message} (RequestId: {request_id})")
    }
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
    let url = format!("{}/?{}", aliyun_endpoint(cfg), query);
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
    require_aliyun_config(cfg)?;
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
    insert_if_present(&mut p, "AutoRetry", &cfg.pnvs_auto_retry);
    p.insert(
        "ReturnVerifyCode".into(),
        cfg.sms_expose_mock_code.to_string(),
    );

    let body = call(cfg, http, p).await?;
    if !aliyun_success(&body) {
        return Err(aliyun_error("SendSmsVerifyCode", &body));
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
    require_aliyun_config(cfg)?;
    let mut p = common_params(cfg, "CheckSmsVerifyCode");
    p.insert("PhoneNumber".into(), phone.into());
    p.insert("VerifyCode".into(), code.into());
    p.insert("CountryCode".into(), cfg.pnvs_country_code.clone());
    insert_if_present(&mut p, "CaseAuthPolicy", &cfg.pnvs_case_auth_policy);
    let body = call(cfg, http, p).await?;
    if !aliyun_success(&body) {
        return Err(aliyun_error("CheckSmsVerifyCode", &body));
    }
    let pass = body
        .get("Model")
        .and_then(|m| m.get("VerifyResult"))
        .and_then(|c| c.as_str())
        == Some("PASS");
    Ok(pass)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliyun_endpoint_accepts_plain_host_or_url() {
        let mut cfg = Config::from_env();
        cfg.pnvs_endpoint = "dypnsapi.aliyuncs.com".to_string();
        assert_eq!(aliyun_endpoint(&cfg), "https://dypnsapi.aliyuncs.com");
        cfg.pnvs_endpoint = "https://dypnsapi.aliyuncs.com/".to_string();
        assert_eq!(aliyun_endpoint(&cfg), "https://dypnsapi.aliyuncs.com");
    }

    #[test]
    fn send_sms_params_follow_pnvs_dynamic_code_contract() {
        let mut cfg = Config::from_env();
        cfg.aliyun_ak_id = "ak".to_string();
        cfg.aliyun_ak_secret = "secret".to_string();
        cfg.pnvs_sign_name = "速通互联验证码".to_string();
        cfg.pnvs_template_code = "100001".to_string();
        cfg.sms_code_ttl_secs = 300;
        cfg.sms_code_length = 6;
        cfg.sms_cooldown_secs = 60;
        let mut p = common_params(&cfg, "SendSmsVerifyCode");
        let ttl_min = (cfg.sms_code_ttl_secs / 60).max(1).to_string();
        let template_param = serde_json::json!({
            cfg.pnvs_code_var.clone(): "##code##",
            cfg.pnvs_ttl_var.clone(): ttl_min,
        });
        p.insert("TemplateParam".into(), template_param.to_string());
        p.insert("CodeLength".into(), cfg.sms_code_length.to_string());
        p.insert("ValidTime".into(), cfg.sms_code_ttl_secs.to_string());
        p.insert("Interval".into(), cfg.sms_cooldown_secs.to_string());
        insert_if_present(&mut p, "AutoRetry", &cfg.pnvs_auto_retry);

        assert_eq!(
            p.get("Action").map(String::as_str),
            Some("SendSmsVerifyCode")
        );
        assert!(p.get("TemplateParam").unwrap().contains("##code##"));
        assert_eq!(p.get("CodeLength").map(String::as_str), Some("6"));
        assert_eq!(p.get("ValidTime").map(String::as_str), Some("300"));
        assert_eq!(p.get("Interval").map(String::as_str), Some("60"));
        assert_eq!(p.get("AutoRetry").map(String::as_str), Some("1"));
    }
}
