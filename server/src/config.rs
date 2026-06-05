use std::env;

use serde::Deserialize;
use serde_json::json;

#[derive(Clone, Debug)]
pub struct ModelConfig {
    pub id: String,
    pub display_name: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub user_jwt_secret: String,
    pub admin_jwt_secret: String,
    // Upstream OpenAI-compatible relay (server-side only key).
    pub upstream_base_url: String,
    pub upstream_api_key: String,
    pub default_model: String,
    pub models: Vec<ModelConfig>,
    // Free quota for brand-new users.
    pub free_turns: i64,
    // Per-request token reservation when a precise estimate is unavailable.
    pub reserve_tokens: i64,
    pub max_body_bytes: usize,
    // Allow the test/demo "manual" payment confirmation to grant entitlements.
    // MUST be false in production once real payment providers are configured.
    pub allow_manual_pay: bool,
    // SMS
    pub sms_provider: String,
    pub sms_code_ttl_secs: i64,
    pub sms_cooldown_secs: i64,
    pub sms_code_length: i64,
    pub sms_expose_mock_code: bool,
    pub sms_mock_code: String,
    pub aliyun_ak_id: String,
    pub aliyun_ak_secret: String,
    pub pnvs_sign_name: String,
    pub pnvs_template_code: String,
    pub pnvs_endpoint: String,
    pub pnvs_country_code: String,
    pub pnvs_code_var: String,
    pub pnvs_ttl_var: String,
    pub pnvs_duplicate_policy: String,
    pub pnvs_code_type: String,
    pub pnvs_auto_retry: String,
    pub pnvs_case_auth_policy: String,
    // Admin bootstrap
    pub admin_bootstrap_user: String,
    pub admin_bootstrap_pass: String,
}

fn ev(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn ev_trim(key: &str) -> String {
    env::var(key).unwrap_or_default().trim().to_string()
}

fn preferred_provider() -> String {
    let explicit = ev("UPSTREAM_PROVIDER", "");
    if !explicit.trim().is_empty() {
        return explicit.trim().to_lowercase();
    }
    let model_provider = ev("MODEL_PROVIDER", "");
    if !model_provider.trim().is_empty() {
        return model_provider.trim().to_lowercase();
    }
    if env::var("GLM_API_KEY").is_ok()
        || env::var("GLM_BASE_URL").is_ok()
        || env::var("GLM_MODEL").is_ok()
    {
        return "glm".to_string();
    }
    "openai".to_string()
}

#[derive(Deserialize)]
struct ModelCatalogEntry {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_key_env: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default = "default_catalog_enabled")]
    enabled: bool,
}

fn default_catalog_enabled() -> bool {
    true
}

fn default_api_key_env(provider: &str) -> &'static str {
    match provider {
        "glm" => "GLM_API_KEY",
        "deepseek" => "DEEPSEEK_API_KEY",
        _ => "OPENAI_API_KEY",
    }
}

fn default_base_url(provider: &str) -> String {
    match provider {
        "glm" => ev("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
        "deepseek" => ev("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"),
        _ => ev("OPENAI_BASE_URL", "https://llmapi.debinxiang.top/v1"),
    }
}

fn push_model(models: &mut Vec<ModelConfig>, id: String, display_name: String, provider: &str) {
    let id = id.trim().to_string();
    if id.is_empty() || models.iter().any(|model| model.id == id) {
        return;
    }
    let provider = provider.trim().to_lowercase();
    let api_key_env = default_api_key_env(&provider);
    models.push(ModelConfig {
        id,
        display_name,
        provider: provider.clone(),
        base_url: default_base_url(&provider),
        api_key: ev_trim(api_key_env),
    });
}

fn configured_models(
    default_model: &str,
    fallback_base_url: &str,
    fallback_api_key: &str,
) -> Vec<ModelConfig> {
    if let Ok(raw) = env::var("DESKAGENT_MODEL_CATALOG") {
        let parsed = serde_json::from_str::<Vec<ModelCatalogEntry>>(&raw);
        if let Ok(entries) = parsed {
            let mut out = Vec::new();
            for entry in entries.into_iter().filter(|entry| entry.enabled) {
                let id = entry.id.trim().to_string();
                if id.is_empty() || out.iter().any(|model: &ModelConfig| model.id == id) {
                    continue;
                }
                let provider = entry
                    .provider
                    .unwrap_or_else(|| "openai".to_string())
                    .trim()
                    .to_lowercase();
                let api_key = entry.api_key.unwrap_or_else(|| {
                    ev_trim(
                        entry
                            .api_key_env
                            .as_deref()
                            .unwrap_or(default_api_key_env(&provider)),
                    )
                });
                out.push(ModelConfig {
                    display_name: entry
                        .display_name
                        .or(entry.name)
                        .unwrap_or_else(|| id.clone()),
                    id,
                    provider: provider.clone(),
                    base_url: entry
                        .base_url
                        .unwrap_or_else(|| default_base_url(&provider)),
                    api_key,
                });
            }
            if !out.is_empty() {
                return out;
            }
        } else if !raw.trim().is_empty() {
            tracing::warn!("DESKAGENT_MODEL_CATALOG is not valid JSON; using provider defaults");
        }
    }

    let mut models = Vec::new();
    push_model(
        &mut models,
        ev("GLM_MODEL", "glm-5.1"),
        ev("GLM_DISPLAY_NAME", "GLM 5.1"),
        "glm",
    );
    push_model(
        &mut models,
        ev("DEEPSEEK_MODEL", "deepseek-v4-pro"),
        ev("DEEPSEEK_DISPLAY_NAME", "DeepSeek V4 Pro"),
        "deepseek",
    );
    if env::var("OPENAI_API_KEY").is_ok() || env::var("OPENAI_BASE_URL").is_ok() {
        push_model(
            &mut models,
            ev("ADAPTER_MODEL", &ev("OPENAI_MODEL", default_model)),
            ev("OPENAI_DISPLAY_NAME", "OpenAI Relay"),
            "openai",
        );
    }
    if !models.iter().any(|model| model.id == default_model) {
        models.push(ModelConfig {
            id: default_model.to_string(),
            display_name: ev("DEFAULT_MODEL_DISPLAY_NAME", default_model),
            provider: preferred_provider(),
            base_url: fallback_base_url.to_string(),
            api_key: fallback_api_key.to_string(),
        });
    }
    models
}

impl Config {
    pub fn from_env() -> Self {
        let provider = preferred_provider();
        let upstream_base_url = if provider == "glm" {
            ev("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")
        } else {
            ev("OPENAI_BASE_URL", "https://llmapi.debinxiang.top/v1")
        };
        let upstream_api_key = if provider == "glm" {
            ev("GLM_API_KEY", "")
        } else {
            ev("OPENAI_API_KEY", "")
        };
        let default_model = if provider == "glm" {
            ev("GLM_MODEL", "glm-5.1")
        } else {
            ev("ADAPTER_MODEL", &ev("OPENAI_MODEL", "glm-5.1"))
        };
        let models = configured_models(&default_model, &upstream_base_url, &upstream_api_key);
        Config {
            database_url: ev("DATABASE_URL", "sqlite://deskagent.db?mode=rwc"),
            bind_addr: ev("BIND_ADDR", "127.0.0.1:8787"),
            user_jwt_secret: ev("USER_JWT_SECRET", "dev-user-secret-change-me"),
            admin_jwt_secret: ev("ADMIN_JWT_SECRET", "dev-admin-secret-change-me"),
            upstream_base_url,
            upstream_api_key,
            default_model,
            models,
            free_turns: ev("FREE_TURNS", "20").parse().unwrap_or(20),
            reserve_tokens: ev("RESERVE_TOKENS", "4000").parse().unwrap_or(4000),
            max_body_bytes: ev("MAX_BODY_BYTES", "2097152").parse().unwrap_or(2_097_152),
            allow_manual_pay: ev("ALLOW_MANUAL_PAY", "false") == "true",
            sms_provider: ev("SMS_PROVIDER", "aliyun_pnvs"),
            sms_code_ttl_secs: ev("SMS_CODE_TTL_SECS", "300").parse().unwrap_or(300),
            sms_cooldown_secs: ev("SMS_SEND_COOLDOWN_SECS", "60").parse().unwrap_or(60),
            sms_code_length: ev("SMS_CODE_LENGTH", "6").parse().unwrap_or(6),
            sms_expose_mock_code: ev("SMS_EXPOSE_MOCK_CODE", "false") == "true",
            sms_mock_code: ev("SMS_MOCK_CODE", "123456"),
            aliyun_ak_id: ev("ALIBABA_CLOUD_ACCESS_KEY_ID", ""),
            aliyun_ak_secret: ev("ALIBABA_CLOUD_ACCESS_KEY_SECRET", ""),
            pnvs_sign_name: ev("ALIYUN_PNVS_SIGN_NAME", ""),
            pnvs_template_code: ev("ALIYUN_PNVS_TEMPLATE_CODE", ""),
            pnvs_endpoint: ev("ALIYUN_PNVS_ENDPOINT", "dypnsapi.aliyuncs.com"),
            pnvs_country_code: ev("ALIYUN_PNVS_COUNTRY_CODE", "86"),
            pnvs_code_var: ev("ALIYUN_PNVS_TEMPLATE_CODE_VAR", "code"),
            pnvs_ttl_var: ev("ALIYUN_PNVS_TEMPLATE_TTL_VAR", "min"),
            pnvs_duplicate_policy: ev("ALIYUN_PNVS_DUPLICATE_POLICY", "1"),
            pnvs_code_type: ev("ALIYUN_PNVS_CODE_TYPE", "1"),
            pnvs_auto_retry: ev("ALIYUN_PNVS_AUTO_RETRY", "1"),
            pnvs_case_auth_policy: ev("ALIYUN_PNVS_CASE_AUTH_POLICY", "1"),
            admin_bootstrap_user: ev("ADMIN_BOOTSTRAP_USER", "admin"),
            admin_bootstrap_pass: ev("ADMIN_BOOTSTRAP_PASS", "admin123"),
        }
    }

    pub fn model(&self, id: &str) -> Option<ModelConfig> {
        self.models.iter().find(|model| model.id == id).cloned()
    }

    pub fn public_models(&self) -> Vec<serde_json::Value> {
        self.models
            .iter()
            .map(|model| {
                json!({
                    "id": &model.id,
                    "name": &model.display_name,
                    "display_name": &model.display_name,
                    "provider": &model.provider,
                    "configured": !model.api_key.trim().is_empty(),
                })
            })
            .collect()
    }

    pub fn is_mock_sms(&self) -> bool {
        self.sms_provider == "mock"
            || self.aliyun_ak_id.is_empty()
            || self.aliyun_ak_secret.is_empty()
    }
}
