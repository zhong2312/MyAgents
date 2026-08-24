use serde::{Deserialize, Serialize};

pub const XAI_SUBSCRIPTION_PROVIDER_ID: &str = "xai-sub";
pub const XAI_OAUTH_ISSUER: &str = "https://auth.x.ai";
pub const XAI_OIDC_DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
pub const XAI_DEVICE_CODE_URL: &str = "https://auth.x.ai/oauth2/device/code";
pub const XAI_OAUTH_CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const XAI_OAUTH_SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
pub const XAI_API_BASE_URL: &str = "https://api.x.ai/v1";
pub const XAI_MODELS_URL: &str = "https://api.x.ai/v1/models";
pub const XAI_RESPONSES_URL: &str = "https://api.x.ai/v1/responses";
pub const XAI_PRIMARY_MODEL: &str = "grok-4.5";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrokAuthErrorCode {
    AuthRequired,
    EntitlementRequired,
    RateLimited,
    Network,
    InvalidResponse,
    LoginDenied,
    LoginExpired,
    LoginCancelled,
    LoginUnavailable,
    StoreBusy,
    StoreCorrupt,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokAuthError {
    pub code: GrokAuthErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(default)]
    pub retryable: bool,
}

impl GrokAuthError {
    pub fn new(code: GrokAuthErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            http_status: None,
            retryable: false,
        }
    }

    pub fn http(
        code: GrokAuthErrorCode,
        status: u16,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            http_status: Some(status),
            retryable,
        }
    }
}

impl std::fmt::Display for GrokAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GrokAuthError {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokAccountSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl GrokAccountSummary {
    pub fn label(&self) -> String {
        self.email
            .clone()
            .or_else(|| self.display_name.clone())
            .unwrap_or_else(|| "Grok 订阅账户".to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokAuthStatus {
    pub state: String,
    pub has_grant: bool,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<GrokAccountSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<GrokAuthError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokDeviceLoginView {
    pub session_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_uri_complete: Option<String>,
    pub expires_at: i64,
    pub poll_interval_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<GrokAccountSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<GrokAuthError>,
}

#[derive(Debug, Clone)]
pub struct ResolvedBearer {
    pub access_token: String,
    pub credential_version: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveBearerReason {
    Request,
    AuthRecovery,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveBearerPurpose {
    Execution,
    Verification { expected_lineage: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementBearerRequest {
    pub sidecar_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub rejected_credential_version: Option<u64>,
    #[serde(default)]
    pub http_status: Option<u16>,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub expected_lineage: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagementBearerResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<GrokAuthError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokVerificationResult {
    pub success: bool,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<GrokAccountSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<GrokAuthError>,
}
