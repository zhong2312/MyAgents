use std::collections::BTreeMap;

use super::attachments::*;
use super::cli::*;
use super::delivery::*;
use super::registered_agents::*;
use super::*;

#[test]
fn space_environment_serializes_only_current_public_values() {
    assert_eq!(
        serde_json::to_value(SpaceEnvironment::Production).expect("serialize production"),
        serde_json::json!("production")
    );
    assert_eq!(
        serde_json::to_value(SpaceEnvironment::Dev).expect("serialize Dev"),
        serde_json::json!("dev")
    );
}

#[test]
fn legacy_staging_config_maps_to_dev_only_when_dev_is_baked_in() {
    for configured in [Some("dev"), Some("staging")] {
        assert_eq!(
            resolve_configured_space_environment(configured, true),
            SpaceEnvironment::Dev
        );
        assert_eq!(
            resolve_configured_space_environment(configured, false),
            SpaceEnvironment::Production
        );
    }
    assert_eq!(
        resolve_configured_space_environment(Some("unknown"), true),
        SpaceEnvironment::Production
    );
    assert_eq!(
        resolve_configured_space_environment(None, true),
        SpaceEnvironment::Production
    );
}

#[test]
fn dev_state_uses_an_isolated_data_directory() {
    let root = PathBuf::from("space-root");
    assert_eq!(
        space_data_dir_path_for_environment(root.clone(), SpaceEnvironment::Production),
        root
    );
    assert_eq!(
        space_data_dir_path_for_environment(root.clone(), SpaceEnvironment::Dev),
        root.join("dev")
    );
}

#[cfg(not(debug_assertions))]
#[test]
fn release_build_discards_dev_origin() {
    assert!(SPACE_DEV_BASE_URL_ENV.is_none_or(|value| value.trim().is_empty()));
    assert!(!space_build_capability()
        .environments
        .contains(&SpaceEnvironment::Dev));
}

pub(super) fn test_space_session(user_id: &str) -> SpaceSession {
    SpaceSession::authenticated(
        SpaceAccountPublic {
            base_url: "https://space.myagents.test".to_string(),
            user: serde_json::json!({ "id": user_id }),
            account_plan: Value::Null,
            space: serde_json::json!({ "id": "space_test" }),
            membership: serde_json::json!({ "role": "admin" }),
            spaces: Vec::new(),
            last_active_space_id: None,
            updated_at: "2026-07-03T00:00:00.000Z".to_string(),
        },
        "session-token".to_string(),
        None,
    )
}

#[test]
fn legacy_session_is_read_but_next_write_is_canonical() {
    let legacy = serde_json::json!({
        "baseUrl": "https://space.myagents.test",
        "sessionToken": "legacy-token",
        "expiresAt": "2026-09-01T00:00:00Z",
        "user": { "id": "usr_legacy" },
        "accountPlan": null,
        "space": { "id": "space_test" },
        "membership": { "role": "admin" },
        "spaces": [],
        "lastActiveSpaceId": null,
        "updatedAt": "2026-08-14T00:00:00Z"
    });

    let session: SpaceSession =
        serde_json::from_value(legacy).expect("legacy session should migrate on read");
    assert_eq!(session.authenticated_token(), Some("legacy-token"));

    let canonical = serde_json::to_value(session).expect("serialize canonical session");
    assert!(canonical.get("sessionToken").is_none());
    assert!(canonical.get("expiresAt").is_none());
    assert_eq!(
        canonical
            .pointer("/userCredential/state")
            .and_then(Value::as_str),
        Some("authenticated")
    );
    assert_eq!(
        canonical
            .pointer("/userCredential/sessionToken")
            .and_then(Value::as_str),
        Some("legacy-token")
    );
}

#[test]
fn reauth_session_serialization_cannot_retain_a_user_token() {
    let mut session = test_space_session("usr_current");
    let binding = session.session_binding_id();
    session.user_credential = SpaceUserCredential::ReauthRequired {
        invalidated_session_binding_id: binding.clone(),
    };

    assert_eq!(session.authenticated_token(), None);
    let persisted = serde_json::to_string(&session).expect("serialize reauth session");
    assert!(!persisted.contains("session-token"));
    let view = SpaceSessionView::from(session);
    assert!(matches!(
        view,
        SpaceSessionView::ReauthRequired {
            invalidated_session_binding_id,
            ..
        } if invalidated_session_binding_id == binding
    ));
}

#[test]
fn only_user_session_http_401_requires_reauthentication() {
    assert!(should_require_space_reauth(
        reqwest::StatusCode::UNAUTHORIZED,
        SpaceCredentialKind::UserSession
    ));
    assert!(!should_require_space_reauth(
        reqwest::StatusCode::UNAUTHORIZED,
        SpaceCredentialKind::RegisteredAgent
    ));
    for status in [
        reqwest::StatusCode::FORBIDDEN,
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        reqwest::StatusCode::INTERNAL_SERVER_ERROR,
    ] {
        assert!(!should_require_space_reauth(
            status,
            SpaceCredentialKind::UserSession
        ));
    }
}

#[test]
fn reauth_transition_is_fenced_by_the_exact_session_binding() {
    let dir = tempfile::tempdir().expect("session tempdir");
    let path = session_path_in_dir(dir.path());
    let old = test_space_session("usr_old");
    let old_binding = old.session_binding_id();
    let mut replacement = test_space_session("usr_new");
    replacement.user_credential = SpaceUserCredential::Authenticated {
        session_token: "replacement-token".to_string(),
        expires_at: None,
    };
    let replacement_binding = replacement.session_binding_id();
    write_private_json(&path, &replacement).expect("write replacement session");

    assert!(
        !mark_user_session_reauth_required_at_path(&path, &old_binding)
            .expect("stale transition should be ignored")
    );
    assert_eq!(
        read_session_from_path(&path)
            .expect("read replacement")
            .expect("replacement exists")
            .authenticated_token(),
        Some("replacement-token")
    );

    assert!(
        mark_user_session_reauth_required_at_path(&path, &replacement_binding)
            .expect("current transition should commit")
    );
    let stored = read_session_from_path(&path)
        .expect("read reauth session")
        .expect("reauth session exists");
    assert_eq!(
        stored.invalidated_session_binding_id(),
        Some(replacement_binding.as_str())
    );
    assert_eq!(stored.authenticated_token(), None);
}

#[test]
fn in_flight_refresh_cannot_restore_an_invalidated_token() {
    let dir = tempfile::tempdir().expect("session tempdir");
    let path = session_path_in_dir(dir.path());
    let current = test_space_session("usr_current");
    let binding = current.session_binding_id();
    let mut stale_refresh = current.clone();
    stale_refresh.user = serde_json::json!({ "id": "usr_stale_refresh" });
    write_private_json(&path, &current).expect("write current session");
    mark_user_session_reauth_required_at_path(&path, &binding).expect("invalidate current session");

    assert!(commit_refreshed_session_blocking(&path, stale_refresh).is_err());
    let stored = read_session_from_path(&path)
        .expect("read invalidated session")
        .expect("invalidated session exists");
    assert_eq!(stored.authenticated_token(), None);
    assert_eq!(
        stored.user.pointer("/id").and_then(Value::as_str),
        Some("usr_current")
    );
}

#[test]
fn legacy_space_session_json_defaults_multi_space_fields() {
    let session: SpaceSession = serde_json::from_value(serde_json::json!({
        "baseUrl": "https://space.myagents.test",
        "sessionToken": "session-token",
        "expiresAt": null,
        "user": { "id": "usr_legacy" },
        "space": { "id": "official", "slug": "official" },
        "membership": { "role": "member" },
        "updatedAt": "2026-07-06T00:00:00.000Z"
    }))
    .expect("legacy session should deserialize without new fields");

    assert!(session.spaces.is_empty());
    assert!(session.last_active_space_id.is_none());
}

#[test]
fn successful_me_response_without_account_plan_falls_back_to_free() {
    let mut session = test_space_session("usr_current");
    session.account_plan = serde_json::json!({
        "effectiveTier": "pro",
        "membership": {
            "planTier": "pro",
            "status": "active",
            "expiresAt": "2026-10-11T00:00:00.000Z",
            "version": 3
        }
    });

    let refreshed = session_from_me_data(
        &session,
        &serde_json::json!({
            "user": { "id": "usr_current" },
            "space": { "id": "space_test" },
            "membership": { "role": "admin" }
        }),
    );

    assert!(refreshed.account_plan.is_null());
}

#[test]
fn refreshed_session_commit_preserves_the_latest_local_active_space() {
    let dir = tempfile::tempdir().expect("session tempdir");
    let path = session_path_in_dir(dir.path());
    let mut current = test_space_session("usr_current");
    current.last_active_space_id = Some("team".to_string());
    write_private_json(&path, &current).expect("write current session");

    let mut stale_refresh = current.clone();
    stale_refresh.last_active_space_id = Some("official".to_string());
    stale_refresh.updated_at = "2026-07-13T00:00:00.000Z".to_string();

    let committed =
        commit_refreshed_session_blocking(&path, stale_refresh).expect("commit refreshed session");
    let stored = read_session_from_path(&path)
        .expect("read committed session")
        .expect("session should remain present");

    assert_eq!(committed.last_active_space_id.as_deref(), Some("team"));
    assert_eq!(stored.last_active_space_id.as_deref(), Some("team"));
}

#[test]
fn active_space_write_rejects_a_replaced_session() {
    let dir = tempfile::tempdir().expect("session tempdir");
    let path = session_path_in_dir(dir.path());
    let old_session = test_space_session("usr_old");
    let old_binding = space_session_binding_id(&old_session);
    let mut new_session = test_space_session("usr_new");
    new_session.user_credential = SpaceUserCredential::Authenticated {
        session_token: "new-session-token".to_string(),
        expires_at: None,
    };
    write_private_json(&path, &new_session).expect("write new session");

    let error =
        set_active_space_in_session_file(&path, &new_session.base_url, &old_binding, "team")
            .expect_err("old session must not update the replacement session");
    let stored = read_session_from_path(&path)
        .expect("read replacement session")
        .expect("replacement session should remain present");

    assert!(error.contains("session changed"));
    assert_eq!(stored.authenticated_token(), Some("new-session-token"));
    assert!(stored.last_active_space_id.is_none());
}

#[test]
fn logout_takes_the_local_session_before_remote_revoke() {
    let dir = tempfile::tempdir().expect("session tempdir");
    let path = session_path_in_dir(dir.path());
    let session = test_space_session("usr_current");
    write_private_json(&path, &session).expect("write current session");

    let removed = take_session_for_logout(&path)
        .expect("logout should take the current session")
        .expect("session should be returned for remote revoke");

    assert_eq!(removed.authenticated_token(), session.authenticated_token());
    assert!(read_session_from_path(&path)
        .expect("read removed session")
        .is_none());
}

#[test]
fn local_logout_prevents_an_in_flight_refresh_from_recreating_the_session() {
    let dir = tempfile::tempdir().expect("session tempdir");
    let path = session_path_in_dir(dir.path());
    let session = test_space_session("usr_current");
    write_private_json(&path, &session).expect("write current session");

    take_session_for_logout(&path).expect("logout should remove current session");
    let error = commit_refreshed_session_blocking(&path, session)
        .expect_err("refresh must not recreate a logged-out session");

    assert!(error.contains("session changed"));
    assert!(read_session_from_path(&path)
        .expect("read removed session")
        .is_none());
}

#[test]
fn stale_auth_poll_cannot_replace_a_newer_login_or_explicit_logout() {
    let dir = tempfile::tempdir().expect("session tempdir");
    let path = session_path_in_dir(dir.path());
    let reauth = test_space_session("usr_old");
    let expected_binding = reauth.session_binding_id();
    let mut reauth = reauth;
    reauth.user_credential = SpaceUserCredential::ReauthRequired {
        invalidated_session_binding_id: expected_binding.clone(),
    };
    write_private_json(&path, &reauth).expect("write reauth session");

    let mut newer_login = test_space_session("usr_new");
    newer_login.user_credential = SpaceUserCredential::Authenticated {
        session_token: "new-session-token".to_string(),
        expires_at: None,
    };
    write_private_json(&path, &newer_login).expect("write newer login");
    let stale_login = test_space_session("usr_old");

    assert!(!commit_authenticated_session_if_unchanged_at_path(
        &path,
        Some(&expected_binding),
        &stale_login,
    )
    .expect("stale poll should be ignored"));
    assert_eq!(
        read_session_from_path(&path)
            .expect("read newer login")
            .and_then(|session| session.authenticated_token().map(ToString::to_string))
            .as_deref(),
        Some("new-session-token")
    );

    take_session_for_logout(&path).expect("logout should remove newer login");
    assert!(!commit_authenticated_session_if_unchanged_at_path(
        &path,
        Some(&expected_binding),
        &stale_login,
    )
    .expect("logged-out poll should be ignored"));
    assert!(read_session_from_path(&path)
        .expect("read logged-out state")
        .is_none());
}

pub(super) fn test_registered_agent(
    owner_user_id: Option<&str>,
    device_id: Option<&str>,
) -> LocalRegisteredAgent {
    LocalRegisteredAgent {
        id: "rag_legacy".to_string(),
        base_url: "https://space.myagents.test".to_string(),
        space_id: "space_test".to_string(),
        owner_user_id: owner_user_id.map(ToString::to_string),
        device_id: device_id.map(ToString::to_string),
        client_id: None,
        device_name: None,
        device_platform: None,
        device_os_version: None,
        device_app_version: None,
        device_last_seen_at: None,
        local_workspace_id: Some("workspace_test".to_string()),
        local_agent_id: Some("local_agent_test".to_string()),
        workspace_id: Some("workspace_test".to_string()),
        display_name: "Legacy Agent".to_string(),
        instruction: Some("Triage matching issues and act when useful.".to_string()),
        instruction_revision: 1,
        subscriptions: vec![SpaceGoalSubscriptionSummary {
            id: "sub_test".to_string(),
            space_id: "space_test".to_string(),
            actor_type: "registered_agent".to_string(),
            actor_id: "rag_legacy".to_string(),
            goal_id: "goal_test".to_string(),
            include_subtree: true,
            goal_path_label: Some("Root / Legacy".to_string()),
            state_filter: vec!["todo".to_string()],
            created_at: "2026-07-03T00:00:00.000Z".to_string(),
        }],
        workspace_path: "/tmp/myagents-legacy".to_string(),
        workspace_label: Some("Legacy".to_string()),
        avatar_url: None,
        avatar_source: None,
        avatar_preset_id: None,
        avatar_urls: None,
        goal_id: Some("goal_test".to_string()),
        goal_path_label: Some("Root / Legacy".to_string()),
        state_filter: vec!["todo".to_string()],
        goal_md: None,
        delivery_session_id: Some("session_legacy".to_string()),
        issue_subscription_run_mode: SpaceIssueSubscriptionRunMode::SingleSession,
        issue_session_ids: BTreeMap::new(),
        token: "registered-agent-token".to_string(),
        status: "active".to_string(),
        created_at: "2026-07-03T00:00:00.000Z".to_string(),
        updated_at: "2026-07-03T00:00:00.000Z".to_string(),
    }
}

#[tokio::test]
async fn cli_context_requires_exact_registered_agent_identity() {
    let _mock = crate::space_cloud_mock::enable_for_test();
    let workspace = std::env::current_dir().expect("current workspace");
    let unregistered_workspace =
        tempfile::tempdir_in(&workspace).expect("unregistered workspace inside project");
    let user_context = resolve_space_cli_context(
        "official",
        None,
        None,
        unregistered_workspace.path().to_str(),
        None,
    )
    .await
    .expect("unregistered workspace should use the User actor");
    assert!(matches!(user_context.actor, SpaceCliActor::User { .. }));

    cmd_space_update_registered_agent(SpaceUpdateRegisteredAgentInput {
        id: "rag_mock_frontend".to_string(),
        display_name: None,
        instruction: None,
        expected_instruction_revision: None,
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        workspace_label: None,
        goal_id: None,
        state_filter: None,
        goal_md: None,
        status: None,
        issue_subscription_run_mode: None,
    })
    .await
    .expect("mock Agent should bind to current workspace");
    let workspace_context = resolve_space_cli_context(
        "official",
        None,
        Some("project-current"),
        workspace.to_str(),
        None,
    )
    .await
    .expect("workspace identity alone must remain the User actor");
    assert!(matches!(
        workspace_context.actor,
        SpaceCliActor::User { .. }
    ));

    let exact_origin = SpaceCliRegisteredAgentOrigin {
        space_id: "space_mock_official".to_string(),
        registered_agent_id: "rag_mock_frontend".to_string(),
    };
    let origin_context = resolve_space_cli_context(
        "official",
        Some(&exact_origin),
        Some("project-current"),
        workspace.to_str(),
        None,
    )
    .await
    .expect("the exact Session origin should select its Registered Agent");
    assert!(matches!(
        origin_context.actor,
        SpaceCliActor::RegisteredAgent { ref id, .. } if id == "rag_mock_frontend"
    ));
    assert!(origin_context.user_session.is_none());

    let wrong_agent_origin = SpaceCliRegisteredAgentOrigin {
        space_id: "space_mock_official".to_string(),
        registered_agent_id: "rag_missing".to_string(),
    };
    assert!(resolve_space_cli_context(
        "official",
        Some(&wrong_agent_origin),
        Some("project-current"),
        workspace.to_str(),
        None,
    )
    .await
    .expect_err("an unknown origin Agent must not fall back to User")
    .contains("SPACE_AGENT_BINDING_INVALID"));

    let wrong_space_origin = SpaceCliRegisteredAgentOrigin {
        space_id: "space_other".to_string(),
        registered_agent_id: "rag_mock_frontend".to_string(),
    };
    assert!(resolve_space_cli_context(
        "official",
        Some(&wrong_space_origin),
        Some("project-current"),
        workspace.to_str(),
        None,
    )
    .await
    .expect_err("a cross-Space origin must fail closed")
    .contains("SPACE_AGENT_BINDING_INVALID"));

    let agent_context = resolve_space_cli_context(
        "official",
        None,
        Some("project-current"),
        workspace.to_str(),
        Some("rag_mock_frontend"),
    )
    .await
    .expect("an exact Registered Agent id should select that actor");
    assert!(matches!(
        agent_context.actor,
        SpaceCliActor::RegisteredAgent { ref id, .. } if id == "rag_mock_frontend"
    ));

    let candidates = space_cli_assignee_list(SpaceCliContextInput {
        space_slug: "official".to_string(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
    })
    .await
    .expect("Registered Agent candidate list");
    let items = candidates
        .get("items")
        .and_then(Value::as_array)
        .expect("candidate items");
    assert!(items.iter().any(|item| {
        item.get("assigneeId").and_then(Value::as_str) == Some("agent:rag_mock_frontend")
            && item.get("isSelf").and_then(Value::as_bool) == Some(true)
    }));
    assert!(items
        .iter()
        .all(|item| item.get("avatarUrl").is_none() && item.get("role").is_none()));

    let issue_file =
        tempfile::NamedTempFile::new_in(&workspace).expect("issue attachment inside workspace");
    fs::write(issue_file.path(), b"issue evidence").expect("write issue attachment");
    let created = space_cli_issue_create(SpaceCliIssueCreateInput {
        space_slug: "official".to_string(),
        title: "Atomic CLI issue".to_string(),
        body: "Created with one attachment".to_string(),
        goal_id: None,
        assignee_id: None,
        human_only: None,
        file_paths: vec![issue_file.path().to_string_lossy().to_string()],
        session_id: None,
        session_origin: None,
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
    })
    .await
    .expect("Registered Agent should create Issue with attachments atomically");
    assert_eq!(
        created
            .pointer("/issue/creator/type")
            .and_then(Value::as_str),
        Some("registered_agent")
    );
    assert_eq!(
        created
            .pointer("/issue/attachmentCount")
            .and_then(Value::as_u64),
        Some(1)
    );
    assert!(created
        .pointer("/attachments/0/id")
        .and_then(Value::as_str)
        .is_some());
}

#[test]
fn cli_agent_binding_fails_closed_after_owner_demotion_or_token_loss() {
    let mut agent = test_registered_agent(Some("usr_current"), Some("device_current"));
    assert!(cli_agent_owner_binding_is_valid(
        &agent,
        "usr_current",
        "device_current",
        "owner"
    ));
    assert!(!cli_agent_owner_binding_is_valid(
        &agent,
        "usr_current",
        "device_current",
        "member"
    ));
    agent.token.clear();
    assert!(!cli_agent_owner_binding_is_valid(
        &agent,
        "usr_current",
        "device_current",
        "owner"
    ));
}

#[tokio::test]
async fn cli_goal_list_and_issue_update_use_user_and_registered_agent_contexts() {
    let _mock = crate::space_cloud_mock::enable_for_test();
    let workspace = std::env::current_dir().expect("current workspace");
    let user_workspace = tempfile::tempdir_in(&workspace).expect("User workspace inside project");

    let created_goal = crate::space_cloud_mock::api_data_request_with_token(
        "POST",
        "/api/spaces/official/goals",
        Some("mock-session-token"),
        Some(serde_json::json!({
            "parentGoalId": "goal_mock_root",
            "title": "Archived CLI Goal",
            "context": "Used to verify includeArchived passthrough."
        })),
    )
    .expect("create mock Goal");
    let archived_goal_id = created_goal
        .pointer("/goal/id")
        .and_then(Value::as_str)
        .expect("created Goal ID")
        .to_string();
    crate::space_cloud_mock::api_data_request_with_token(
        "POST",
        &format!("/api/goals/{archived_goal_id}/archive"),
        Some("mock-session-token"),
        None,
    )
    .expect("archive mock Goal");

    let user_context = || SpaceCliGoalListInput {
        space_slug: "official".to_string(),
        include_archived: false,
        session_id: None,
        session_origin: None,
        workspace_id: None,
        workspace_path: Some(user_workspace.path().to_string_lossy().to_string()),
        agent_id: None,
    };
    let active_goals = space_cli_goal_list(user_context())
        .await
        .expect("User should list active Goals");
    assert!(active_goals
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().all(|goal| {
            goal.get("id").and_then(Value::as_str) != Some(archived_goal_id.as_str())
        })));
    let archived_goals = space_cli_goal_list(SpaceCliGoalListInput {
        include_archived: true,
        ..user_context()
    })
    .await
    .expect("User should include archived Goals on request");
    assert!(archived_goals
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|goal| {
            goal.get("id").and_then(Value::as_str) == Some(archived_goal_id.as_str())
                && goal.get("archivedAt").is_some_and(|value| !value.is_null())
        })));

    let user_issue = space_cli_issue_create(SpaceCliIssueCreateInput {
        space_slug: "official".to_string(),
        title: "User metadata update".to_string(),
        body: "Created under the root Goal".to_string(),
        goal_id: Some("goal_mock_root".to_string()),
        assignee_id: None,
        human_only: None,
        file_paths: Vec::new(),
        session_id: None,
        session_origin: None,
        workspace_id: None,
        workspace_path: Some(user_workspace.path().to_string_lossy().to_string()),
        agent_id: None,
    })
    .await
    .expect("User should create Issue");
    let user_issue_id = user_issue
        .pointer("/issue/id")
        .and_then(Value::as_str)
        .expect("User Issue ID")
        .to_string();
    assert_eq!(
        user_issue
            .pointer("/issue/creator/type")
            .and_then(Value::as_str),
        Some("user")
    );
    let user_updated = space_cli_issue_update(SpaceCliIssueUpdateInput {
        issue_id: user_issue_id,
        space_slug: "official".to_string(),
        title: Some("User updated title".to_string()),
        body: None,
        goal_update: Some(SpaceCliIssueGoalUpdate::Clear),
        human_only: Some(false),
        session_id: None,
        session_origin: None,
        workspace_id: None,
        workspace_path: Some(user_workspace.path().to_string_lossy().to_string()),
        agent_id: None,
    })
    .await
    .expect("User should update Issue metadata");
    assert_eq!(
        user_updated.pointer("/issue/title").and_then(Value::as_str),
        Some("User updated title")
    );
    assert!(user_updated
        .pointer("/issue/goalId")
        .is_some_and(Value::is_null));
    assert!(user_updated
        .pointer("/issue/goalPathLabel")
        .is_some_and(Value::is_null));

    cmd_space_update_registered_agent(SpaceUpdateRegisteredAgentInput {
        id: "rag_mock_frontend".to_string(),
        display_name: None,
        instruction: None,
        expected_instruction_revision: None,
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        workspace_label: None,
        goal_id: None,
        state_filter: None,
        goal_md: None,
        status: None,
        issue_subscription_run_mode: None,
    })
    .await
    .expect("bind mock Registered Agent to current workspace");
    let exact_origin = SpaceCliRegisteredAgentOrigin {
        space_id: "space_mock_official".to_string(),
        registered_agent_id: "rag_mock_frontend".to_string(),
    };
    let agent_goals = space_cli_goal_list(SpaceCliGoalListInput {
        space_slug: "official".to_string(),
        include_archived: false,
        session_id: None,
        session_origin: Some(exact_origin.clone()),
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        agent_id: None,
    })
    .await
    .expect("Registered Agent should list Goals");
    assert!(agent_goals
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty()));

    let agent_issue = space_cli_issue_create(SpaceCliIssueCreateInput {
        space_slug: "official".to_string(),
        title: "Agent metadata update".to_string(),
        body: "Claim and assignment must survive Goal edits".to_string(),
        goal_id: Some("goal_mock_runtime".to_string()),
        assignee_id: Some("agent:rag_mock_frontend".to_string()),
        human_only: Some(false),
        file_paths: Vec::new(),
        session_id: None,
        session_origin: Some(exact_origin.clone()),
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        agent_id: None,
    })
    .await
    .expect("Registered Agent should create assigned Issue");
    let agent_issue_id = agent_issue
        .pointer("/issue/id")
        .and_then(Value::as_str)
        .expect("Agent Issue ID")
        .to_string();
    let claimed = space_cli_issue_claim(SpaceCliIssueClaimInput {
        issue_id: agent_issue_id.clone(),
        space_slug: "official".to_string(),
        delivery_id: None,
        session_id: None,
        session_origin: Some(exact_origin.clone()),
        workspace_id: Some("project-current".to_string()),
        agent_id: None,
        workspace_path: Some(workspace.to_string_lossy().to_string()),
    })
    .await
    .expect("Registered Agent should claim its assigned Issue");
    let claim_id = claimed
        .pointer("/claim/id")
        .and_then(Value::as_str)
        .expect("claim ID")
        .to_string();
    let set_goal = space_cli_issue_update(SpaceCliIssueUpdateInput {
        issue_id: agent_issue_id.clone(),
        space_slug: "official".to_string(),
        title: None,
        body: None,
        goal_update: Some(SpaceCliIssueGoalUpdate::Set {
            goal_id: "goal_mock_ui".to_string(),
        }),
        human_only: Some(false),
        session_id: None,
        session_origin: Some(exact_origin.clone()),
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        agent_id: None,
    })
    .await
    .expect("Registered Agent should set Goal");
    assert_eq!(
        set_goal.pointer("/issue/goalId").and_then(Value::as_str),
        Some("goal_mock_ui")
    );
    assert_eq!(
        set_goal
            .pointer("/issue/goalPathLabel")
            .and_then(Value::as_str),
        Some("MyAgents社区 / UI Quality")
    );
    assert_eq!(
        set_goal
            .pointer("/issue/assignee/id")
            .and_then(Value::as_str),
        Some("rag_mock_frontend")
    );
    assert_eq!(
        set_goal.pointer("/issue/claim/id").and_then(Value::as_str),
        Some(claim_id.as_str())
    );

    let cleared = space_cli_issue_update(SpaceCliIssueUpdateInput {
        issue_id: agent_issue_id.clone(),
        space_slug: "official".to_string(),
        title: None,
        body: None,
        goal_update: Some(SpaceCliIssueGoalUpdate::Clear),
        human_only: None,
        session_id: None,
        session_origin: Some(exact_origin),
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(workspace.to_string_lossy().to_string()),
        agent_id: None,
    })
    .await
    .expect("Registered Agent should clear Goal");
    assert!(cleared.pointer("/issue/goalId").is_some_and(Value::is_null));
    assert!(cleared
        .pointer("/issue/goalPathLabel")
        .is_some_and(Value::is_null));
    assert_eq!(
        cleared.pointer("/issue/state").and_then(Value::as_str),
        Some("open")
    );
    assert_eq!(
        cleared
            .pointer("/issue/assignee/id")
            .and_then(Value::as_str),
        Some("rag_mock_frontend")
    );
    assert_eq!(
        cleared.pointer("/issue/claim/id").and_then(Value::as_str),
        Some(claim_id.as_str())
    );
}

#[test]
fn cli_workspace_identity_prefers_stable_id_and_limits_path_fallback_to_legacy_rows() {
    let workspace = std::env::current_dir().expect("workspace");
    let mut modern = test_registered_agent(Some("usr_test"), Some("device_test"));
    modern.local_workspace_id = Some("project-current".to_string());
    modern.workspace_path = workspace
        .join("moved-old-location")
        .to_string_lossy()
        .to_string();
    assert!(cli_workspace_matches(
        &modern,
        Some("project-current"),
        &workspace
    ));
    assert!(!cli_workspace_matches(&modern, None, &workspace));

    let mut legacy = modern.clone();
    legacy.local_workspace_id = None;
    legacy.workspace_id = None;
    legacy.workspace_path = workspace.to_string_lossy().to_string();
    assert!(cli_workspace_matches(&legacy, None, &workspace));
    assert!(!cli_workspace_matches(
        &legacy,
        Some("project-current"),
        &workspace
    ));
}

#[tokio::test]
async fn attachment_draft_inspection_returns_bounded_metadata_before_submit() {
    let file = tempfile::NamedTempFile::new().expect("draft file");
    fs::write(file.path(), b"draft-bytes").expect("write draft");
    let drafts = cmd_space_inspect_attachment_drafts(SpaceInspectAttachmentDraftsInput {
        file_paths: vec![file.path().to_string_lossy().to_string()],
    })
    .await
    .expect("draft inspection should succeed");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].size_bytes, 11);
    assert_eq!(drafts[0].path, file.path().to_string_lossy());
}

#[test]
fn completion_attachment_operation_key_hashes_the_prepared_upload_bytes() {
    let make = |bytes: &[u8]| PreparedAttachment {
        path: PathBuf::from("result.bin"),
        name: "result.bin".to_string(),
        mime_type: "application/octet-stream",
        size_bytes: bytes.len() as u64,
        bytes: bytes.to_vec(),
    };
    let first = complete_operation_key_for_attachments("base", &[make(b"first")]);
    let repeated = complete_operation_key_for_attachments("base", &[make(b"first")]);
    let changed = complete_operation_key_for_attachments("base", &[make(b"second")]);
    assert_eq!(first, repeated);
    assert_ne!(first, changed);
}

#[tokio::test]
async fn mock_space_delivery_routes_poll_mark_and_process() {
    let _mock = crate::space_cloud_mock::enable_for_test();

    let pending = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        empty_streak: None,
    })
    .await
    .expect("mock deliveries should poll");
    let items = pending
        .pointer("/data/items")
        .and_then(Value::as_array)
        .expect("delivery items");
    assert!(!items.is_empty());
    assert!(items[0]
        .pointer("/issueMeta/number")
        .and_then(Value::as_u64)
        .is_some());
    let delivery_id = items[0]
        .pointer("/delivery/id")
        .and_then(Value::as_str)
        .expect("delivery id")
        .to_string();

    let marked = cmd_space_mark_delivery_delivered(SpaceMarkDeliveryDeliveredInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        delivery_id,
        session_id: Some("session-space-delivery".to_string()),
    })
    .await
    .expect("mock delivery should mark delivered");
    assert_eq!(
        marked.pointer("/data/delivered").and_then(Value::as_bool),
        Some(true)
    );

    let empty = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        empty_streak: None,
    })
    .await
    .expect("mock deliveries should poll after mark");
    assert_eq!(
        empty
            .pointer("/data/items")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(0)
    );

    crate::space_cloud_mock::reset();
    let processed = crate::space_cloud_mock::process_deliveries_once();
    assert!(processed.processed >= 1);
    assert_eq!(processed.delivered, processed.processed);
}

#[test]
fn mock_registered_agent_me_routes_require_valid_agent_token() {
    let _mock = crate::space_cloud_mock::enable_for_test();

    let invalid = crate::space_cloud_mock::api_data_request_with_token(
        "GET",
        "/api/registered-agents/me/deliveries?status=pending&limit=20",
        Some("not-a-registered-agent-token"),
        None,
    );
    assert!(invalid.is_err());

    let valid = crate::space_cloud_mock::api_data_request_with_token(
        "GET",
        "/api/registered-agents/me/deliveries?status=pending&limit=20",
        Some("mock-token-rag_mock_frontend"),
        None,
    )
    .expect("valid registered agent token should poll");
    let items = valid
        .pointer("/items")
        .and_then(Value::as_array)
        .expect("delivery items");
    assert!(!items.is_empty());
    assert!(items.iter().all(|item| {
        item.pointer("/issueMeta/number")
            .and_then(Value::as_u64)
            .is_some()
    }));
    assert!(items.iter().all(|item| {
        item.pointer("/delivery/registeredAgentId")
            .and_then(Value::as_str)
            == Some("rag_mock_frontend")
    }));

    crate::space_cloud_mock::api_data_request(
        "PATCH",
        "/api/registered-agents/rag_mock_frontend",
        Some(serde_json::json!({ "status": "disabled" })),
    )
    .expect("mock agent should disable");
    let disabled = crate::space_cloud_mock::api_data_request_with_token(
        "GET",
        "/api/registered-agents/me/deliveries?status=pending&limit=20",
        Some("mock-token-rag_mock_frontend"),
        None,
    );
    assert!(disabled.is_err());
}

#[tokio::test]
async fn mock_remote_agent_workspace_binding_update_is_rejected() {
    let _mock = crate::space_cloud_mock::enable_for_test();

    let result = cmd_space_update_registered_agent(SpaceUpdateRegisteredAgentInput {
        id: "rag_mock_windows".to_string(),
        display_name: None,
        instruction: None,
        expected_instruction_revision: None,
        workspace_id: None,
        workspace_path: None,
        workspace_label: Some("Changed Remotely".to_string()),
        goal_id: None,
        state_filter: None,
        goal_md: None,
        status: None,
        issue_subscription_run_mode: None,
    })
    .await;

    assert!(result
        .expect_err("remote workspace binding update must be rejected")
        .message
        .contains("workspace binding"));
}

#[tokio::test]
async fn mock_space_assigned_update_falls_back_after_claim_completion() {
    let _mock = crate::space_cloud_mock::enable_for_test();

    let pending = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        empty_streak: None,
    })
    .await
    .expect("mock deliveries should poll");
    let first = pending
        .pointer("/data/items/0")
        .expect("first delivery should exist");
    let issue_id = first
        .pointer("/delivery/issueId")
        .and_then(Value::as_str)
        .expect("issue id")
        .to_string();
    let delivery_id = first
        .pointer("/delivery/id")
        .and_then(Value::as_str)
        .expect("delivery id")
        .to_string();

    let claim = space_cli_issue_claim(SpaceCliIssueClaimInput {
        issue_id: issue_id.clone(),
        space_slug: "official".to_string(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project_myagents".to_string()),
        delivery_id: Some(delivery_id),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: None,
    })
    .await
    .expect("claim should succeed");
    let claim_id = claim
        .pointer("/claim/id")
        .and_then(Value::as_str)
        .expect("claim id")
        .to_string();
    assert_eq!(
        claim.pointer("/claim/actorType").and_then(Value::as_str),
        Some("registered_agent")
    );

    let linked = space_cli_claim_local_task(SpaceCliClaimLocalTaskInput {
        claim_id: claim_id.clone(),
        local_task_id: "task_claim".to_string(),
        local_session_id: "session_claim".to_string(),
        space_slug: "official".to_string(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project_myagents".to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: None,
    })
    .await
    .expect("local task binding should succeed");
    assert_eq!(
        linked.get("localSessionId").and_then(Value::as_str),
        Some("session_claim")
    );

    space_cli_issue_complete(SpaceCliIssueActionInput {
        issue_id: issue_id.clone(),
        space_slug: "official".to_string(),
        result_comment: Some("Mock atomic result".to_string()),
        operation_key: Some("test-complete-operation".to_string()),
        operation_key_subject: None,
        rollback: None,
        expected_notification_version: None,
        file_paths: Vec::new(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project_myagents".to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: None,
    })
    .await
    .expect("complete should keep handler");
    let detail = space_cli_issue_get(SpaceCliIssueGetInput {
        issue_id: issue_id.clone(),
        space_slug: "official".to_string(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project_myagents".to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: None,
        comments_cursor: None,
        comments_limit: Some(5),
    })
    .await
    .expect("detail should load");
    assert_eq!(
        detail.pointer("/issue/state").and_then(Value::as_str),
        Some("done")
    );
    assert!(detail
        .pointer("/comments/items")
        .and_then(Value::as_array)
        .is_some_and(|comments| comments.iter().any(|comment| {
            comment.get("body").and_then(Value::as_str) == Some("Mock atomic result")
        })));
    assert!(detail.get("claim").is_some_and(Value::is_null));
    assert_eq!(
        detail.pointer("/issue/assignee/id").and_then(Value::as_str),
        Some("rag_mock_frontend")
    );
    let result_comment_count = detail
        .pointer("/comments/items")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let repeated = space_cli_issue_complete(SpaceCliIssueActionInput {
        issue_id: issue_id.clone(),
        space_slug: "official".to_string(),
        result_comment: Some("Mock atomic result".to_string()),
        operation_key: Some("test-complete-operation".to_string()),
        operation_key_subject: None,
        rollback: None,
        expected_notification_version: None,
        file_paths: Vec::new(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project_myagents".to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: None,
    })
    .await
    .expect("repeated complete should be idempotent");
    assert_eq!(
        repeated.get("idempotent").and_then(Value::as_bool),
        Some(true)
    );
    let repeated_detail = space_cli_issue_get(SpaceCliIssueGetInput {
        issue_id: issue_id.clone(),
        space_slug: "official".to_string(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project_myagents".to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: None,
        comments_cursor: None,
        comments_limit: Some(5),
    })
    .await
    .expect("detail should remain readable after idempotent complete");
    assert_eq!(
        repeated_detail
            .pointer("/comments/items")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(result_comment_count)
    );

    cmd_space_api_request(SpaceApiRequestInput {
        method: "POST".to_string(),
        path: format!("/api/issues/{}/comments", issue_id),
        body: Some(serde_json::json!({ "body": "human follow-up question" })),
    })
    .await
    .expect("human comment should succeed");

    let deliveries = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        empty_streak: None,
    })
    .await
    .expect("deliveries should poll after comment");
    let assignment = deliveries
        .pointer("/data/items")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|item| {
                item.pointer("/delivery/deliveryKind")
                    .and_then(Value::as_str)
                    == Some("assignment")
            })
        })
        .expect("post-completion assignment update should exist");
    assert!(assignment
        .pointer("/delivery/targetSessionId")
        .is_some_and(Value::is_null));
    assert!(assignment
        .pointer("/delivery/claimId")
        .is_some_and(Value::is_null));
    let assignment_delivery_id = assignment
        .pointer("/delivery/id")
        .and_then(Value::as_str)
        .expect("assignment delivery id")
        .to_string();

    let processed = crate::space_cloud_mock::process_deliveries_once();
    assert!(processed.processed >= 1);
    let delivered_assignment = crate::space_cloud_mock::delivery_by_id(&assignment_delivery_id)
        .expect("processed assignment delivery");
    assert_eq!(
        delivered_assignment
            .pointer("/delivery/status")
            .and_then(Value::as_str),
        Some("delivered")
    );
    let delivered_session_id = delivered_assignment
        .pointer("/delivery/deliveredToSessionId")
        .and_then(Value::as_str)
        .expect("post-completion assignment should use the Agent fallback session");
    assert!(!delivered_session_id.is_empty());
    assert_ne!(delivered_session_id, "session_claim");

    space_cli_issue_comment(SpaceCliIssueCommentInput {
        issue_id: issue_id.clone(),
        body: "agent self update".to_string(),
        space_slug: "official".to_string(),
        file_paths: Vec::new(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project_myagents".to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: None,
    })
    .await
    .expect("agent self comment should succeed");
    let after_self_comment = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        empty_streak: None,
    })
    .await
    .expect("deliveries should poll after self comment");
    let assignment_count_after = after_self_comment
        .pointer("/data/items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.pointer("/delivery/deliveryKind")
                        .and_then(Value::as_str)
                        == Some("assignment")
                })
                .count()
        })
        .unwrap_or(0);
    assert_eq!(assignment_count_after, 0);
}

#[tokio::test]
async fn mock_space_issue_comment_routes_are_mutable_and_method_guarded() {
    let _mock = crate::space_cloud_mock::enable_for_test();
    let official = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/spaces/official".to_string(),
        body: None,
    })
    .await
    .expect("official metadata should load");
    assert_eq!(
        official.pointer("/data/space/name").and_then(Value::as_str),
        Some("MyAgents社区")
    );
    assert!(official
        .pointer("/data/tags")
        .and_then(Value::as_array)
        .map(|items| items.len() >= 7)
        .unwrap_or(false));

    let issue_list = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/spaces/official/issues?limit=30".to_string(),
        body: None,
    })
    .await
    .expect("issue list should load");
    assert!(issue_list
        .pointer("/data/items")
        .and_then(Value::as_array)
        .map(|items| items.len() >= 18)
        .unwrap_or(false));

    let skill_list = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/spaces/official/skills".to_string(),
        body: None,
    })
    .await
    .expect("skill list should load");
    assert!(skill_list
        .pointer("/data/items")
        .and_then(Value::as_array)
        .map(|items| items.len() >= 10)
        .unwrap_or(false));
    assert!(cmd_space_list_local_agents().await.expect("agents").len() >= 5);

    let created_tag = cmd_space_api_request(SpaceApiRequestInput {
        method: "POST".to_string(),
        path: "/api/spaces/official/tags".to_string(),
        body: Some(serde_json::json!({ "name": "qa-contract" })),
    })
    .await
    .expect("custom tag should create");
    let custom_tag_id = created_tag
        .pointer("/data/tag/id")
        .and_then(Value::as_str)
        .expect("custom tag id")
        .to_string();

    let created_issue = cmd_space_api_request(SpaceApiRequestInput {
        method: "POST".to_string(),
        path: "/api/spaces/official/issues".to_string(),
        body: Some(serde_json::json!({
            "title": "Tag id contract",
            "body": "Created with a tag id, not a tag name.",
            "tags": [custom_tag_id]
        })),
    })
    .await
    .expect("issue should create with tag id");
    let created_issue_id = created_issue
        .pointer("/data/issue/id")
        .and_then(Value::as_str)
        .expect("created issue id")
        .to_string();
    assert_eq!(
        created_issue
            .pointer("/data/issue/tags/0/name")
            .and_then(Value::as_str),
        Some("qa-contract")
    );

    let filtered_by_tag_id = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: format!(
            "/api/spaces/official/issues?tag={}",
            url_component(&custom_tag_id)
        ),
        body: None,
    })
    .await
    .expect("issue list should filter by tag id");
    assert!(filtered_by_tag_id
        .pointer("/data/items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(&created_issue_id))
        })
        .unwrap_or(false));

    let result = cmd_space_api_request(SpaceApiRequestInput {
        method: "POST".to_string(),
        path: "/api/issues/iss_mock_001/comments".to_string(),
        body: Some(serde_json::json!({ "body": "补一条来自测试的评论" })),
    })
    .await
    .expect("comment should succeed");

    assert_eq!(result.get("success").and_then(Value::as_bool), Some(true));
    assert_eq!(
        result.pointer("/data/comment/body").and_then(Value::as_str),
        Some("补一条来自测试的评论")
    );
    let comment_id = result
        .pointer("/data/comment/id")
        .and_then(Value::as_str)
        .expect("comment id")
        .to_string();
    let exact_comment = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: format!(
            "/api/issues/iss_mock_001/comments/{}",
            url_component(&comment_id)
        ),
        body: None,
    })
    .await
    .expect("exact comment should load");
    assert_eq!(
        exact_comment
            .pointer("/data/comment/body")
            .and_then(Value::as_str),
        Some("补一条来自测试的评论")
    );

    let assignment_issue_id = "iss_mock_002";
    let assigned = cmd_space_api_request(SpaceApiRequestInput {
        method: "PUT".to_string(),
        path: format!("/api/issues/{}/assignee", assignment_issue_id),
        body: Some(serde_json::json!({
            "assignee": { "type": "registered_agent", "id": "rag_mock_frontend" }
        })),
    })
    .await
    .expect("PUT assignee should be supported");
    assert_eq!(
        assigned
            .pointer("/data/issue/assignee/id")
            .and_then(Value::as_str),
        Some("rag_mock_frontend")
    );
    let assignment_deliveries = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        empty_streak: None,
    })
    .await
    .expect("assignment delivery should poll");
    assert!(assignment_deliveries
        .pointer("/data/items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| {
            item.pointer("/delivery/issueId").and_then(Value::as_str) == Some(assignment_issue_id)
                && item
                    .pointer("/delivery/deliveryKind")
                    .and_then(Value::as_str)
                    == Some("assignment")
        })));
    let reopened = cmd_space_api_request(SpaceApiRequestInput {
        method: "POST".to_string(),
        path: format!("/api/issues/{}/assignee/cancel", assignment_issue_id),
        body: Some(serde_json::json!({})),
    })
    .await
    .expect("assignee cancellation should reopen issue");
    assert!(reopened
        .pointer("/data/issue/assignee")
        .is_some_and(Value::is_null));
    assert_eq!(
        reopened
            .pointer("/data/issue/state")
            .and_then(Value::as_str),
        Some("todo")
    );
    let pending_after_cancel = cmd_space_poll_deliveries(SpacePollDeliveriesInput {
        registered_agent_id: "rag_mock_frontend".to_string(),
        empty_streak: None,
    })
    .await
    .expect("deliveries should poll after assignment cancellation");
    assert!(!pending_after_cancel
        .pointer("/data/items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| {
            item.pointer("/delivery/issueId").and_then(Value::as_str) == Some(assignment_issue_id)
                && item
                    .pointer("/delivery/deliveryKind")
                    .and_then(Value::as_str)
                    == Some("assignment")
        })));

    let detail = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/issues/iss_mock_001?commentsLimit=5".to_string(),
        body: None,
    })
    .await
    .expect("issue detail should load");

    let comments = detail
        .pointer("/data/comments/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_eq!(comments.len(), 1);
    assert_eq!(
        comments[0].get("body").and_then(Value::as_str),
        Some("补一条来自测试的评论")
    );

    let cli_workspace = std::env::current_dir().expect("current workspace");
    cmd_space_update_registered_agent(SpaceUpdateRegisteredAgentInput {
        id: "rag_mock_frontend".to_string(),
        display_name: None,
        instruction: None,
        expected_instruction_revision: None,
        workspace_id: Some("project-current".to_string()),
        workspace_path: Some(cli_workspace.to_string_lossy().to_string()),
        workspace_label: None,
        goal_id: None,
        state_filter: None,
        goal_md: None,
        status: None,
        issue_subscription_run_mode: None,
    })
    .await
    .expect("mock Agent workspace should become a real temp directory");
    let data = space_cli_issue_comment(SpaceCliIssueCommentInput {
        issue_id: "iss_mock_002".to_string(),
        body: "Agent 已读取并开始处理。".to_string(),
        space_slug: "official".to_string(),
        file_paths: Vec::new(),
        session_id: None,
        session_origin: None,
        workspace_id: Some("project-current".to_string()),
        agent_id: Some("rag_mock_frontend".to_string()),
        workspace_path: Some(cli_workspace.to_string_lossy().to_string()),
    })
    .await
    .expect("cli comment should succeed");

    assert_eq!(
        data.pointer("/comment/body").and_then(Value::as_str),
        Some("Agent 已读取并开始处理。")
    );

    let comment_file = tempfile::NamedTempFile::new_in(&cli_workspace)
        .expect("comment attachment inside workspace");
    fs::write(comment_file.path(), b"comment evidence").expect("write comment attachment");
    let comment_with_attachment =
        cmd_space_comment_issue_with_attachments(SpaceCommentIssueWithAttachmentsInput {
            issue_id: "iss_mock_002".to_string(),
            body: String::new(),
            file_paths: vec![comment_file.path().to_string_lossy().to_string()],
        })
        .await
        .expect("attachment-only comment should succeed atomically");
    assert_eq!(
        comment_with_attachment
            .pointer("/comment/attachments/0/name")
            .and_then(Value::as_str),
        comment_file
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .map(safe_local_filename)
            .as_deref()
    );
    let comment_attachment_id = comment_with_attachment
        .pointer("/comment/attachments/0/id")
        .and_then(Value::as_str)
        .expect("comment attachment id")
        .to_string();
    let nested_detail = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/issues/iss_mock_002?commentsLimit=5".to_string(),
        body: None,
    })
    .await
    .expect("detail with comment attachment should load");
    assert!(nested_detail
        .pointer("/data/attachments")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().all(|attachment| {
            attachment.get("id").and_then(Value::as_str) != Some(comment_attachment_id.as_str())
        })));
    assert!(nested_detail
        .pointer("/data/comments/items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|comment| {
            comment
                .pointer("/attachments/0/id")
                .and_then(Value::as_str)
                .is_some()
        })));

    let status = cmd_space_api_request(SpaceApiRequestInput {
        method: "POST".to_string(),
        path: "/api/issues/iss_mock_002/status".to_string(),
        body: Some(serde_json::json!({ "status": "resolved" })),
    })
    .await
    .expect("status should update");
    assert_eq!(
        status.pointer("/data/status").and_then(Value::as_str),
        Some("resolved")
    );

    let dispatch = cmd_space_api_request(SpaceApiRequestInput {
        method: "POST".to_string(),
        path: "/api/issues/iss_mock_002/dispatch".to_string(),
        body: Some(serde_json::json!({ "registeredAgentId": "rag_mock_frontend" })),
    })
    .await
    .expect("dispatch should succeed");
    assert_eq!(
        dispatch
            .pointer("/data/dispatch/deliveryStatus")
            .and_then(Value::as_str),
        Some("pending")
    );
    let upload_dir = tempfile::tempdir().expect("upload tempdir");
    let upload_source = upload_dir.path().join("trace.log");
    fs::write(&upload_source, "mock trace").expect("write upload source");
    let uploaded = cmd_space_upload_issue_attachments(SpaceUploadIssueAttachmentsInput {
        issue_id: "iss_mock_002".to_string(),
        file_paths: vec![upload_source.to_string_lossy().to_string()],
    })
    .await
    .expect("attachment upload should succeed");
    let uploaded_id = uploaded
        .pointer("/attachments/0/id")
        .and_then(Value::as_str)
        .expect("uploaded attachment id")
        .to_string();
    let events = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/events?limit=100".to_string(),
        body: None,
    })
    .await
    .expect("attachment update event should be visible");
    assert!(events
        .pointer("/data/items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|event| {
            event.get("type").and_then(Value::as_str) == Some("issue.attachments_added")
                && event.get("resourceId").and_then(Value::as_str) == Some("iss_mock_002")
        })));
    let workspace = crate::workspace_files::test_support::make_test_workspace("space_mock");
    let downloaded = cmd_space_download_attachment(SpaceDownloadAttachmentInput {
        attachment_id: uploaded_id,
        workspace_path: workspace.to_string_lossy().to_string(),
        issue_id: Some("iss_mock_002".to_string()),
        file_name: None,
        registered_agent_id: None,
        output: Some("downloaded/trace.log".to_string()),
    })
    .await
    .expect("attachment download should succeed");
    assert!(workspace.join(&downloaded.relative_path).is_file());

    let skill_detail = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/skills/skl_mock_prd_writer".to_string(),
        body: None,
    })
    .await
    .expect("skill detail should load");
    assert_eq!(
        skill_detail
            .pointer("/data/skill/name")
            .and_then(Value::as_str),
        Some("PRD Writer")
    );
    let skill_file = cmd_space_api_request(SpaceApiRequestInput {
        method: "GET".to_string(),
        path: "/api/skills/skl_mock_prd_writer/file-content?path=SKILL.md".to_string(),
        body: None,
    })
    .await
    .expect("skill file should load");
    assert!(skill_file
        .pointer("/data/text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .contains("prd-writer"));
    let package = crate::space_cloud_mock::skill_package_bytes("skl_mock_prd_writer")
        .expect("mock package bytes");
    assert!(package.len() > 100);

    let registered = cmd_space_register_agent(SpaceRegisterAgentInput {
        display_name: "Mock Acceptance Agent".to_string(),
        instruction: "Validate Space Phase 2 mock flows.".to_string(),
        workspace_id: "project_acceptance".to_string(),
        workspace_path: workspace.to_string_lossy().to_string(),
        workspace_label: Some("Acceptance Workspace".to_string()),
        goal_id: "goal_mock_ui".to_string(),
        state_filter: Some(vec!["todo".to_string()]),
        goal_md: Some("Validate Space Phase 2 mock flows.".to_string()),
        issue_subscription_run_mode: None,
    })
    .await
    .expect("agent registration should succeed");
    assert_eq!(registered.display_name, "Mock Acceptance Agent");
    assert_eq!(
        registered.issue_subscription_run_mode,
        SpaceIssueSubscriptionRunMode::SingleSession
    );

    let updated_agent = cmd_space_update_registered_agent(SpaceUpdateRegisteredAgentInput {
        id: registered.id.clone(),
        display_name: Some("Mock Acceptance Agent 2".to_string()),
        instruction: Some("Validate Space Phase 2 mock flows carefully.".to_string()),
        expected_instruction_revision: Some(registered.instruction_revision),
        workspace_id: None,
        workspace_path: None,
        workspace_label: None,
        goal_id: None,
        state_filter: None,
        goal_md: None,
        status: Some("disabled".to_string()),
        issue_subscription_run_mode: Some(SpaceIssueSubscriptionRunMode::NewSession),
    })
    .await
    .expect("agent update should succeed");
    assert_eq!(updated_agent.display_name, "Mock Acceptance Agent 2");
    assert_eq!(updated_agent.status, "disabled");
    assert_eq!(
        updated_agent.issue_subscription_run_mode,
        SpaceIssueSubscriptionRunMode::NewSession
    );

    let revoked_agent =
        cmd_space_revoke_registered_agent(SpaceRegisteredAgentIdInput { id: registered.id })
            .await
            .expect("agent revoke should succeed");
    assert_eq!(revoked_agent.status, "revoked");

    let deleted_skill = cmd_space_api_request(SpaceApiRequestInput {
        method: "DELETE".to_string(),
        path: "/api/skills/skl_mock_issue_triage".to_string(),
        body: None,
    })
    .await
    .expect("skill delete should succeed");
    assert_eq!(
        deleted_skill
            .pointer("/data/deleted")
            .and_then(Value::as_bool),
        Some(true)
    );

    let error = cmd_space_api_request(SpaceApiRequestInput {
        method: "TRACE".to_string(),
        path: "/api/issues/iss_mock_001/comments".to_string(),
        body: Some(serde_json::json!({ "body": "nope" })),
    })
    .await
    .expect_err("TRACE must be rejected");

    assert_eq!(error.code, "SPACE_METHOD_UNSUPPORTED");
    assert_eq!(error.message, "Unsupported Space API method");
    let _ = fs::remove_dir_all(&workspace);
}

#[test]
fn session_space_segment_prefers_slug_for_official_route_compatibility() {
    let session = SpaceSession::authenticated(
        SpaceAccountPublic {
            base_url: "https://space.myagents.test".to_string(),
            user: Value::Null,
            account_plan: Value::Null,
            space: serde_json::json!({
                "id": "space_fb63fde836254c9c90146c4f5bb142bd",
                "slug": "official",
            }),
            membership: Value::Null,
            spaces: Vec::new(),
            last_active_space_id: None,
            updated_at: "2026-06-24T00:00:00.000Z".to_string(),
        },
        "session_test".to_string(),
        None,
    );

    assert_eq!(session_space_segment(&session), "official");
}

#[test]
fn shared_client_context_headers_are_applied_to_space_requests() {
    let capability = SpaceBuildCapability {
        available: true,
        base_url: Some("https://space.myagents.test".to_string()),
        public_client_id: Some("client_test_123".to_string()),
        reason: None,
        environments: vec![SpaceEnvironment::Production],
        active_environment: SpaceEnvironment::Production,
    };
    // The request is never sent; this only constructs a request for an
    // external Space URL so the header helper can be asserted.
    #[allow(clippy::disallowed_methods)]
    let client = reqwest::Client::builder().build().expect("client");
    let request = with_space_client_context_headers(
        client.get("https://space.myagents.test/api/issues/iss_1"),
        &capability,
    )
    .build()
    .expect("request");

    assert_eq!(
        request
            .headers()
            .get(SPACE_PUBLIC_CLIENT_ID_HEADER)
            .and_then(|value| value.to_str().ok()),
        Some("client_test_123")
    );
    assert_eq!(
        request
            .headers()
            .get(SPACE_CLIENT_VERSION_HEADER)
            .and_then(|value| value.to_str().ok()),
        Some(env!("CARGO_PKG_VERSION"))
    );
    assert_eq!(
        request
            .headers()
            .get(SPACE_PLATFORM_HEADER)
            .and_then(|value| value.to_str().ok()),
        Some(SPACE_CLIENT_DEVICE_CONTEXT.platform.as_str())
    );
    assert_eq!(
        request
            .headers()
            .get(ACCEPT_LANGUAGE)
            .and_then(|value| value.to_str().ok()),
        Some(crate::i18n::current_locale().as_str())
    );
    assert!(request.headers().contains_key(USER_AGENT));
    if let Some(device_id) = SPACE_CLIENT_DEVICE_CONTEXT.device_id.as_deref() {
        assert_eq!(
            request
                .headers()
                .get(SPACE_DEVICE_ID_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(device_id)
        );
    }
    assert_eq!(
        request
            .headers()
            .get(SPACE_OS_VERSION_HEADER)
            .and_then(|value| value.to_str().ok()),
        SPACE_CLIENT_DEVICE_CONTEXT.os_version.as_deref()
    );
}

#[test]
fn space_header_facts_strip_control_and_non_ascii_bytes() {
    assert_eq!(
        normalize_space_header_fact(" macOS\n15 雪 ", "unknown"),
        "macOS15"
    );
    assert_eq!(normalize_space_header_fact("\n雪", "unknown"), "unknown");
}
