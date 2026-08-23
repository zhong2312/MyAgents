mod manager;
mod oauth;
mod store;
pub mod types;

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use manager::GrokAuthManager;
use serde::Deserialize;
use serde_json::Value;
use types::{
    GrokAuthError, GrokAuthErrorCode, GrokAuthStatus, GrokDeviceLoginView, GrokVerificationResult,
    ResolveBearerPurpose, ResolveBearerReason, ResolvedBearer,
};

static GROK_AUTH_MANAGER: OnceLock<Arc<GrokAuthManager>> = OnceLock::new();

pub(crate) fn initialize() -> Result<Arc<GrokAuthManager>, GrokAuthError> {
    if let Some(manager) = GROK_AUTH_MANAGER.get() {
        return Ok(Arc::clone(manager));
    }
    let manager = Arc::new(GrokAuthManager::new()?);
    let _ = GROK_AUTH_MANAGER.set(Arc::clone(&manager));
    Ok(GROK_AUTH_MANAGER.get().map(Arc::clone).unwrap_or(manager))
}

fn manager() -> Result<Arc<GrokAuthManager>, GrokAuthError> {
    initialize()
}

pub async fn reconcile_provider_projection() {
    match manager() {
        Ok(manager) => manager.reconcile_projection().await,
        Err(error) => crate::ulog_warn!(
            "[grok-auth] manager initialization failed during reconciliation error={}",
            error
        ),
    }
}

pub async fn resolve_bearer_for_sidecar(
    reason: ResolveBearerReason,
    rejected_credential_version: Option<u64>,
    purpose: ResolveBearerPurpose,
) -> Result<ResolvedBearer, GrokAuthError> {
    manager()?
        .resolve_bearer(reason, rejected_credential_version, purpose)
        .await
}

pub async fn reject_credential_for_sidecar(credential_version: u64) -> Result<(), GrokAuthError> {
    manager()?
        .reject_credential_version(credential_version)
        .await
}

pub async fn record_upstream_outcome_for_sidecar(
    credential_version: u64,
    http_status: u16,
) -> Result<(), GrokAuthError> {
    manager()?
        .record_upstream_outcome(credential_version, http_status)
        .await
}

#[tauri::command]
pub async fn cmd_grok_auth_status() -> Result<GrokAuthStatus, GrokAuthError> {
    manager()?.get_auth_status().await
}

#[tauri::command]
pub async fn cmd_grok_login_start() -> Result<GrokDeviceLoginView, GrokAuthError> {
    manager()?.start_device_login().await
}

#[tauri::command]
pub async fn cmd_grok_login_status(
    session_id: String,
) -> Result<GrokDeviceLoginView, GrokAuthError> {
    manager()?.get_login_status(&session_id).await
}

#[tauri::command]
pub async fn cmd_grok_login_cancel(session_id: String) -> Result<(), GrokAuthError> {
    manager()?.cancel_login(&session_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarGrokVerifyResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
}

#[tauri::command]
pub async fn cmd_grok_verify_account(
    sidecars: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
) -> Result<GrokVerificationResult, GrokAuthError> {
    let auth = manager()?;
    let (model, verification_lineage) = auth.prepare_verification_model().await?;
    let sidecar_manager = sidecars.inner().clone();
    let dispatch = crate::sse_proxy::acquire_global_dispatch_with_wait(&sidecar_manager)
        .await
        .map_err(|_| GrokAuthError::new(GrokAuthErrorCode::Internal, "Grok 验证运行时暂不可用"))?;
    let verify_url = dispatch
        .url_for_path("/api/grok/verify")
        .map_err(|_| GrokAuthError::new(GrokAuthErrorCode::Internal, "Grok 验证运行时暂不可用"))?;

    let verify_result = async {
        let client = crate::local_http::json_client(Duration::from_secs(60));
        let response = client
            .post(verify_url)
            .json(&serde_json::json!({
                "model": model.clone(),
                "verificationLineage": verification_lineage.clone(),
            }))
            .send()
            .await
            .map_err(|_| {
                GrokAuthError::new(GrokAuthErrorCode::Network, "无法连接 Grok 验证运行时")
            })?;
        response
            .json::<SidecarGrokVerifyResponse>()
            .await
            .map_err(|_| {
                GrokAuthError::new(
                    GrokAuthErrorCode::InvalidResponse,
                    "Grok 验证运行时返回了无效结果",
                )
            })
    }
    .await;
    drop(dispatch);

    match verify_result {
        Ok(result) => Ok(auth
            .finalize_bridge_verification(model, verification_lineage, result.success, result.error)
            .await),
        Err(error) => Ok(auth
            .finalize_bridge_verification(model, verification_lineage, false, Some(error.message))
            .await),
    }
}

#[tauri::command]
pub async fn cmd_grok_fetch_models() -> Result<Value, GrokAuthError> {
    manager()?.fetch_models().await
}

#[tauri::command]
pub async fn cmd_grok_logout() -> Result<(), GrokAuthError> {
    manager()?.logout().await
}

pub fn unavailable_error() -> GrokAuthError {
    GrokAuthError::new(GrokAuthErrorCode::Internal, "Grok 登录服务尚未初始化")
}
