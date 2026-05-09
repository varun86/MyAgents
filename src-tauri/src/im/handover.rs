//! Session ↔ Channel surface handover (PRD 0.2.14).
//!
//! Two Tauri commands surface here:
//!
//! * [`cmd_session_new_with_surface_migration`] — desktop user clicks "+新对话"
//!   on a channel-bound session. The channel's `peer_sessions` binding is
//!   rotated to a fresh `session_id`. Behaviour matches IM `/new`.
//!
//! * [`cmd_handover_session_to_channel`] — desktop user clicks the 📤 button on
//!   a pure-desktop session and picks a target channel. The channel's prior
//!   binding (if any) is replaced; the desktop session gains a
//!   `SidecarOwner::Agent(session_key)` so subsequent IM messages route into it.
//!
//! Heavy lifting reuses what already exists:
//!
//! * [`super::router::SessionRouter::reset_session`] handles the `/api/im/session/new`
//!   call to the sidecar plus `cmd_upgrade_session_id`.
//! * [`crate::sidecar::ensure_session_sidecar`] / [`crate::sidecar::release_session_sidecar`]
//!   manage the `SidecarOwner::Agent` lifetime.

use std::path::PathBuf;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use super::router::parse_session_key;
use super::types::PeerSession;
use super::ManagedAgents;
use crate::sidecar::{
    ensure_session_sidecar, release_session_sidecar, ManagedSidecarManager, SidecarOwner,
};
use crate::{ulog_info, ulog_warn};

// ============================================================================
// 1. New conversation with surface migration
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResult {
    pub new_session_id: String,
}

/// Desktop "+新对话" on a channel-bound session.
///
/// Looks up the agent that owns `session_key`, calls
/// `router.reset_session(session_key, …)` which:
///
///   1. Hits `/api/im/session/new` on the sidecar to mint a fresh `sessionId`
///   2. Calls `manager.upgrade_session_id(old, new)` so the sidecar keeps
///      running but is now keyed under the new id
///   3. Updates `peer_sessions[session_key].session_id = new`
///
/// The returned `newSessionId` is what the desktop tab should adopt.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_session_new_with_surface_migration<R: Runtime>(
    app: AppHandle<R>,
    oldSessionId: String,
    sessionKey: String,
) -> Result<NewSessionResult, String> {
    ulog_info!(
        "[handover] surface migration: session={} key={}",
        &oldSessionId[..8.min(oldSessionId.len())],
        sessionKey,
    );

    let agent_state: tauri::State<'_, ManagedAgents> = app
        .try_state()
        .ok_or_else(|| "Agent state unavailable".to_string())?;
    let manager: tauri::State<'_, ManagedSidecarManager> = app
        .try_state()
        .ok_or_else(|| "Sidecar manager unavailable".to_string())?;

    // Locate the channel that owns this session_key. We scan ManagedAgents
    // because session_key encodes agent_id but ChannelInstance routers don't
    // expose a reverse index.
    let parts: Vec<&str> = sessionKey.split(':').collect();
    if parts.len() < 5 || parts[0] != "agent" {
        return Err(format!("Invalid session_key format: {}", sessionKey));
    }
    let target_agent_id = parts[1];

    let router_arc = {
        let agents = agent_state.lock().await;
        let agent = agents.get(target_agent_id).ok_or_else(|| {
            format!(
                "Agent {} not found (channel may be offline)",
                target_agent_id
            )
        })?;

        // The router sits on each ChannelInstance.bot_instance. Find the
        // channel whose router actually has this peer_session entry. The
        // common case is a single-channel agent so the loop is cheap.
        let mut found = None;
        for ch in agent.channels.values() {
            let router_guard = ch.bot_instance.router.lock().await;
            if router_guard.has_peer_session(&sessionKey) {
                drop(router_guard);
                found = Some(ch.bot_instance.router.clone());
                break;
            }
        }
        found
    };

    let router_arc = router_arc.ok_or_else(|| {
        format!(
            "No active channel binds session_key {}; cannot migrate",
            sessionKey
        )
    })?;

    let new_session_id = {
        let mut router = router_arc.lock().await;
        router
            .reset_session(&sessionKey, &app, manager.inner())
            .await?
    };

    ulog_info!(
        "[handover] surface migration done: {} → {}",
        &oldSessionId[..8.min(oldSessionId.len())],
        &new_session_id[..8.min(new_session_id.len())],
    );

    Ok(NewSessionResult { new_session_id })
}

// ============================================================================
// 2. Handover desktop session to channel
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoverResult {
    pub ok: bool,
    pub session_key: String,
    pub notified: bool,
}

/// Bind `session_id` (the desktop session) to `(agent_id, channel_id)`.
///
/// We replace the channel's most-recently-active `peer_session` so the channel
/// continues talking to the same chat (same user / same group), just with the
/// desktop session as the new conversation backend. The old binding's session
/// loses its `Agent` owner; the desktop session gains it.
///
/// The channel sends a notification message to the chat (Q9 lockdown text).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_handover_session_to_channel<R: Runtime>(
    app: AppHandle<R>,
    sessionId: String,
    agentId: String,
    channelId: String,
    workspacePath: String,
) -> Result<HandoverResult, String> {
    ulog_info!(
        "[handover] session={} → agent={} channel={}",
        &sessionId[..8.min(sessionId.len())],
        agentId,
        channelId,
    );

    let agent_state: tauri::State<'_, ManagedAgents> = app
        .try_state()
        .ok_or_else(|| "Agent state unavailable".to_string())?;
    let manager: tauri::State<'_, ManagedSidecarManager> = app
        .try_state()
        .ok_or_else(|| "Sidecar manager unavailable".to_string())?;

    // ----- 1. Resolve target channel + workspace constraint
    let (router_arc, adapter, agent_workspace) = {
        let agents = agent_state.lock().await;
        let agent = agents
            .get(&agentId)
            .ok_or_else(|| format!("Agent {} not found", agentId))?;
        let channel = agent
            .channels
            .get(&channelId)
            .ok_or_else(|| format!("Channel {} not found in agent {}", channelId, agentId))?;
        (
            channel.bot_instance.router.clone(),
            channel.bot_instance.adapter.clone(),
            agent.config.workspace_path.clone(),
        )
    };

    let req_workspace = PathBuf::from(&workspacePath);
    if normalize_str(&agent_workspace) != normalize_path(&req_workspace) {
        return Err(format!(
            "Workspace mismatch: agent workspace = {}, session workspace = {}",
            agent_workspace,
            req_workspace.display(),
        ));
    }

    // ----- 2. Pick the chat to take over (most-recently-active peer_session
    // in this channel). v1 requires at least one prior chat exists so we
    // know which chat_id to bind to.
    let target_session_key = {
        let router = router_arc.lock().await;
        router.most_recent_peer_session_key().ok_or_else(|| {
            "Channel 没有最近活跃的对话；请先在 IM 端发一条消息建立会话".to_string()
        })?
    };

    // ----- 3. Get target sidecar port
    let sidecar_port = {
        let mgr = manager.lock().map_err(|e| e.to_string())?;
        mgr.get_session_port(&sessionId).ok_or_else(|| {
            format!(
                "Session {} has no running Sidecar — open the tab first",
                &sessionId[..8.min(sessionId.len())]
            )
        })?
    };

    // ----- 4. Mutate router: release old binding's Agent owner, install new
    let (chat_id, prior_session_id) = {
        let mut router = router_arc.lock().await;
        let prior = router.peer_session_snapshot(&target_session_key);
        let prior_session_id = prior.as_ref().map(|p| p.session_id.clone());
        let (source_type, source_id) = parse_session_key(&target_session_key);

        // Replace the binding with desktop session
        router.upsert_peer_session(PeerSession {
            session_key: target_session_key.clone(),
            session_id: sessionId.clone(),
            sidecar_port,
            workspace_path: req_workspace.clone(),
            source_type,
            source_id: source_id.clone(),
            message_count: 0,
            last_active: Instant::now(),
        });

        (source_id, prior_session_id)
    };

    // ----- 5. Sidecar owner accounting
    let owner = SidecarOwner::Agent(target_session_key.clone());
    if let Some(prior_sid) = prior_session_id {
        if prior_sid != sessionId {
            // Old session no longer owned by this channel's binding
            let _ = release_session_sidecar(manager.inner(), &prior_sid, &owner);
        }
    }
    // Add Agent owner to target session's Sidecar (already running, this just
    // records the new ownership).
    if let Err(e) = ensure_session_sidecar(
        &app,
        manager.inner(),
        &sessionId,
        &req_workspace,
        owner.clone(),
    ) {
        ulog_warn!("[handover] ensure_session_sidecar failed: {}", e);
        return Err(format!("Failed to attach Agent owner: {}", e));
    }

    // ----- 6. Notify the channel (Q9 lockdown text)
    const NOTIFICATION: &str =
        "🔄 桌面端已将对话交接到此 channel\n完整上下文已带过来，可以直接继续。";
    let notified = match adapter.send_message(&chat_id, NOTIFICATION).await {
        Ok(_) => true,
        Err(e) => {
            ulog_warn!("[handover] notification send failed: {}", e);
            false
        }
    };

    ulog_info!(
        "[handover] done: session={} now bound to {} (notified={})",
        &sessionId[..8.min(sessionId.len())],
        target_session_key,
        notified,
    );

    Ok(HandoverResult {
        ok: true,
        session_key: target_session_key,
        notified,
    })
}

fn normalize_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn normalize_str(s: &str) -> String {
    s.replace('\\', "/")
}

// AnyAdapter::send_message is on `ImAdapter` — pull the trait into scope so
// `adapter.send_message(...)` resolves on `Arc<AnyAdapter>` in §6 above.
use super::adapter::ImAdapter;
