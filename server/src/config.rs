use std::env;

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub user_jwt_secret: String,
    pub admin_jwt_secret: String,
    // Upstream OpenAI-compatible relay (server-side only key).
    pub upstream_base_url: String,
    pub upstream_api_key: String,
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

impl Config {
    pub fn from_env() -> Self {
        let upstream_base_url = ev("OPENAI_BASE_URL", "https://llmapi.debinxiang.top/v1");
        Config {
            database_url: ev("DATABASE_URL", "sqlite://deskagent.db?mode=rwc"),
            bind_addr: ev("BIND_ADDR", "127.0.0.1:8787"),
            user_jwt_secret: ev("USER_JWT_SECRET", "dev-user-secret-change-me"),
            admin_jwt_secret: ev("ADMIN_JWT_SECRET", "dev-admin-secret-change-me"),
            upstream_base_url,
            upstream_api_key: ev("OPENAI_API_KEY", ""),
            free_turns: ev("FREE_TURNS", "3").parse().unwrap_or(3),
            reserve_tokens: ev("RESERVE_TOKENS", "4000").parse().unwrap_or(4000),
            max_body_bytes: ev("MAX_BODY_BYTES", "2097152").parse().unwrap_or(2_097_152),
            allow_manual_pay: ev("ALLOW_MANUAL_PAY", "true") != "false",
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

    pub fn is_mock_sms(&self) -> bool {
        self.sms_provider == "mock"
            || self.aliyun_ak_id.is_empty()
            || self.aliyun_ak_secret.is_empty()
    }
}
