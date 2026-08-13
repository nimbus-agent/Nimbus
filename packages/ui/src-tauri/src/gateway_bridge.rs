use interprocess::local_socket::tokio::{prelude::*, Stream};
#[cfg(not(target_os = "windows"))]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(target_os = "windows")]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::sleep;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct PendingHitl {
    pub request_id: String,
    pub prompt: String,
    pub details: Option<Value>,
    pub received_at_ms: u64,
}

pub struct HitlInbox {
    list: StdMutex<Vec<PendingHitl>>,
}

impl HitlInbox {
    pub fn new() -> Self {
        Self {
            list: StdMutex::new(Vec::new()),
        }
    }
    pub fn push_dedup(&self, r: PendingHitl) -> bool {
        let mut g = self.list.lock().expect("lock poisoned");
        if g.iter().any(|x| x.request_id == r.request_id) {
            return false;
        }
        g.push(r);
        true
    }
    pub fn remove(&self, request_id: &str) {
        let mut g = self.list.lock().expect("lock poisoned");
        g.retain(|x| x.request_id != request_id);
    }
    pub fn snapshot(&self) -> Vec<PendingHitl> {
        self.list.lock().expect("lock poisoned").clone()
    }
}

impl Default for HitlInbox {
    fn default() -> Self {
        Self::new()
    }
}

pub const ALLOWED_METHODS: &[&str] = &[
    "admin.status",
    "agents.catchup",
    "agents.conflicts",
    "agents.decisions",
    "agents.expert",
    "agents.ghost",
    "agents.glossary",
    "agents.huddle",
    "agents.impact",
    "agents.janitor",
    "agents.negotiate",
    "agents.ownership",
    "agents.preflight",
    "agents.premortem",
    "agents.why",
    "agents.whyPeek",
    "audit.export",
    "audit.getSummary",
    "audit.list",
    "audit.verify",
    "chatops.status",
    "connector.list",
    "connector.listStatus",
    "connector.setConfig",
    "connector.startAuth",
    "consent.respond",
    "data.delete",
    "data.export",
    "data.getDeletePreflight",
    "data.getExportPreflight",
    "data.import",
    "db.getMeta",
    "db.setMeta",
    "diag.getVersion",
    "diag.snapshot",
    "egress.head",
    "egress.list",
    "egress.proveWindow",
    "egress.verify",
    "engine.askStream",
    "engine.cancelStream",
    "engine.getSessionTranscript",
    "extension.checkForUpdates",
    "extension.disable",
    "extension.enable",
    "extension.list",
    "extension.remove",
    "extension.update",
    "federation.approvalRespond",
    "federation.consentRespond",
    "federation.discover",
    "federation.namespace.grant",
    "federation.namespace.publish",
    "federation.namespace.revoke",
    "federation.peers",
    "federation.quorumRespond",
    "hitl.listDelegations",
    "hitl.pendingQueue",
    "identity.listBindings",
    "identity.login",
    "identity.logout",
    "identity.status",
    "index.metrics",
    "llm.cancelPull",
    "llm.getRouterStatus",
    "llm.getStatus",
    "llm.listModels",
    "llm.loadModel",
    "llm.pullModel",
    "llm.setDefault",
    "llm.unloadModel",
    "policy.show",
    "profile.create",
    "profile.delete",
    "profile.list",
    "profile.switch",
    "scim.listUsers",
    "scim.status",
    "share.get",
    "share.inbox",
    "share.list",
    "share.pubkey",
    "share.verify",
    "team.auditMerged",
    "teamvault.list",
    "telemetry.getStatus",
    "telemetry.setEnabled",
    "tribal.list",
    "tribal.status",
    "updater.applyUpdate",
    "updater.checkNow",
    "updater.getStatus",
    "updater.rollback",
    "watcher.create",
    "watcher.delete",
    "watcher.list",
    "watcher.listCandidateRelations",
    "watcher.listHistory",
    "watcher.pause",
    "watcher.resume",
    "watcher.validateCondition",
    "workflow.delete",
    "workflow.list",
    "workflow.listRuns",
    "workflow.run",
    "workflow.save",
];

pub fn is_method_allowed(method: &str) -> bool {
    ALLOWED_METHODS.contains(&method)
}

const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(30);

pub const NO_TIMEOUT_METHODS: &[&str] = &[
    "data.export",
    "data.import",
    "identity.login",
    "llm.pullModel",
    "updater.applyUpdate",
];

pub fn is_no_timeout_method(method: &str) -> bool {
    NO_TIMEOUT_METHODS.contains(&method)
}

#[allow(dead_code)]
pub const GLOBAL_BROADCAST_METHODS: &[&str] = &["profile.switched"];

#[allow(dead_code)]
pub fn is_global_broadcast_method(method: &str) -> bool {
    GLOBAL_BROADCAST_METHODS.contains(&method)
}

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, Value>>>>>;

pub struct BridgeState {
    pub(crate) write_tx: Arc<Mutex<Option<mpsc::Sender<Vec<u8>>>>>,
    pub(crate) pending: PendingMap,
    pub(crate) next_id: Arc<Mutex<u64>>,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            write_tx: Arc::new(Mutex::new(None)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
        }
    }
}

pub async fn connect_and_run(app: AppHandle, state: BridgeState) {
    let mut attempt: u32 = 0;
    loop {
        let _ = app.emit("gateway://connection-state", "connecting");

        #[cfg(target_os = "windows")]
        let connect_result = {
            let name =
                std::env::var("NIMBUS_SOCKET").unwrap_or_else(|_| "nimbus-gateway".to_string());
            let ns_name = name
                .to_ns_name::<GenericNamespaced>()
                .expect("valid named pipe");
            Stream::connect(ns_name).await
        };

        #[cfg(not(target_os = "windows"))]
        let connect_result = {
            let path = std::env::var("NIMBUS_SOCKET").unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
                format!("{home}/.local/share/nimbus/nimbus.sock")
            });
            let fs_name = path
                .to_fs_name::<GenericFilePath>()
                .expect("valid socket path");
            Stream::connect(fs_name).await
        };

        match connect_result {
            Ok(stream) => {
                attempt = 0;
                let (read_half, write_half) = stream.split();
                let (tx, rx) = mpsc::channel::<Vec<u8>>(16);
                {
                    let mut w = state.write_tx.lock().await;
                    *w = Some(tx);
                }
                let _ = app.emit("gateway://connection-state", "connected");
                let pending = state.pending.clone();
                let app_cloned = app.clone();
                let reader = BufReader::new(read_half);
                let writer_task = tokio::spawn(run_write_loop(write_half, rx));
                run_read_loop(reader, pending, app_cloned).await;
                writer_task.abort();
                let mut w = state.write_tx.lock().await;
                *w = None;
            }
            Err(_err) => {}
        }
        let _ = app.emit("gateway://connection-state", "disconnected");
        let backoff_ms = match attempt {
            0 => 200,
            1 => 2_000,
            _ => 10_000,
        };
        attempt = attempt.saturating_add(1);
        sleep(Duration::from_millis(backoff_ms)).await;
    }
}

async fn run_write_loop<W>(mut writer: W, mut rx: mpsc::Receiver<Vec<u8>>)
where
    W: AsyncWriteExt + Unpin,
{
    while let Some(data) = rx.recv().await {
        if writer.write_all(&data).await.is_err() {
            break;
        }
        if writer.flush().await.is_err() {
            break;
        }
    }
}

async fn run_read_loop<R>(reader: BufReader<R>, pending: PendingMap, app: AppHandle)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(id) = msg.get("id").and_then(|v| v.as_str()).map(String::from) {
            let mut map = pending.lock().await;
            if let Some(tx) = map.remove(&id) {
                let payload = if let Some(err) = msg.get("error") {
                    Err(err.clone())
                } else {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = tx.send(payload);
            }
        } else if let Some(method) = msg.get("method").and_then(|v| v.as_str()).map(String::from) {
            classify_notification(&app, &method, msg.get("params"));
            let _ = app.emit("gateway://notification", msg);
        }
    }
    let mut map = pending.lock().await;
    for (_id, tx) in map.drain() {
        let _ = tx.send(Err(Value::String("ERR_GATEWAY_OFFLINE".into())));
    }
}

#[tauri::command]
pub async fn rpc_call(
    state: State<'_, BridgeState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if !is_method_allowed(&method) {
        return Err(format!("ERR_METHOD_NOT_ALLOWED:{method}"));
    }
    let tx = {
        let guard = state.write_tx.lock().await;
        guard
            .as_ref()
            .ok_or_else(|| "ERR_GATEWAY_OFFLINE".to_string())?
            .clone()
    };

    let mut id_guard = state.next_id.lock().await;
    *id_guard = id_guard.wrapping_add(1);
    let id = format!("r{}", *id_guard);
    drop(id_guard);

    let frame = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": if params.is_null() { Value::Null } else { params },
    });
    let mut line = frame.to_string();
    line.push('\n');

    let (resp_tx, resp_rx) = oneshot::channel();
    state.pending.lock().await.insert(id.clone(), resp_tx);

    if tx.send(line.into_bytes()).await.is_err() {
        state.pending.lock().await.remove(&id);
        return Err("ERR_GATEWAY_OFFLINE".into());
    }

    if is_no_timeout_method(&method) {
        match resp_rx.await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(e.to_string()),
            Err(_) => Err("ERR_GATEWAY_OFFLINE".into()),
        }
    } else {
        match tokio::time::timeout(DEFAULT_RPC_TIMEOUT, resp_rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(e.to_string()),
            Ok(Err(_)) => Err("ERR_GATEWAY_OFFLINE".into()),
            Err(_elapsed) => {
                state.pending.lock().await.remove(&id);
                Err("ERR_TIMEOUT".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_ws5a_methods() {
        assert!(is_method_allowed("diag.snapshot"));
        assert!(is_method_allowed("connector.list"));
        assert!(is_method_allowed("connector.startAuth"));
        assert!(is_method_allowed("engine.askStream"));
        assert!(is_method_allowed("db.getMeta"));
        assert!(is_method_allowed("db.setMeta"));
    }

    #[test]
    fn allowlist_ws5b_additions() {
        assert!(is_method_allowed("connector.listStatus"));
        assert!(is_method_allowed("index.metrics"));
        assert!(is_method_allowed("audit.list"));
        assert!(is_method_allowed("consent.respond"));
    }

    #[test]
    fn allowlist_ws5c_llm_reads() {
        assert!(is_method_allowed("llm.listModels"));
        assert!(is_method_allowed("llm.getRouterStatus"));
    }

    #[test]
    fn allowlist_ws5c_llm_availability_read() {
        assert!(is_method_allowed("llm.getStatus"));
    }

    #[test]
    fn allowlist_ws5c_llm_writes() {
        assert!(is_method_allowed("llm.pullModel"));
        assert!(is_method_allowed("llm.cancelPull"));
        assert!(is_method_allowed("llm.loadModel"));
        assert!(is_method_allowed("llm.unloadModel"));
        assert!(is_method_allowed("llm.setDefault"));
    }

    #[test]
    fn allowlist_ws5c_connector_writes() {
        assert!(is_method_allowed("connector.setConfig"));
    }

    #[test]
    fn allowlist_ws5c_profile_crud() {
        assert!(is_method_allowed("profile.list"));
        assert!(is_method_allowed("profile.create"));
        assert!(is_method_allowed("profile.switch"));
        assert!(is_method_allowed("profile.delete"));
    }

    #[test]
    fn allowlist_ws5c_audit_surface() {
        assert!(is_method_allowed("audit.getSummary"));
        assert!(is_method_allowed("audit.verify"));
        assert!(is_method_allowed("audit.export"));
    }

    #[test]
    fn allowlist_ws5c_telemetry_surface() {
        assert!(is_method_allowed("telemetry.getStatus"));
        assert!(is_method_allowed("telemetry.setEnabled"));
    }

    #[test]
    fn allowlist_ws5c_updater_surface() {
        assert!(is_method_allowed("updater.getStatus"));
        assert!(is_method_allowed("updater.checkNow"));
        assert!(is_method_allowed("updater.applyUpdate"));
        assert!(is_method_allowed("updater.rollback"));
        assert!(is_method_allowed("diag.getVersion"));
    }

    #[test]
    fn allowlist_ws5c_data_surface() {
        assert!(is_method_allowed("data.getExportPreflight"));
        assert!(is_method_allowed("data.getDeletePreflight"));
        assert!(is_method_allowed("data.export"));
        assert!(is_method_allowed("data.import"));
        assert!(is_method_allowed("data.delete"));
    }

    #[test]
    fn allowlist_rejects_vault_and_raw_db_writes() {
        assert!(!is_method_allowed("vault.get"));
        assert!(!is_method_allowed("vault.set"));
        assert!(!is_method_allowed("vault.list"));
        assert!(!is_method_allowed("vault.delete"));
        assert!(!is_method_allowed("vault.listKeys"));
        assert!(!is_method_allowed("db.put"));
        assert!(!is_method_allowed("db.delete"));
        assert!(!is_method_allowed("config.set"));
        assert!(!is_method_allowed("index.rebuild"));

        assert!(!is_method_allowed("index.querySql"));
    }

    #[test]
    fn allowlist_slice4_read_only_surface() {
        assert!(is_method_allowed("admin.status"));
        assert!(is_method_allowed("policy.show"));
        assert!(is_method_allowed("team.auditMerged"));
    }

    #[test]
    fn allowlist_rejects_slice4_privileged_methods() {
        assert!(!is_method_allowed("policy.sign"));
        assert!(!is_method_allowed("policy.trust"));
        assert!(!is_method_allowed("policy.refetch"));
        assert!(!is_method_allowed("team.purge"));
    }

    #[test]
    fn allowlist_chatops_status_read_only() {
        // Slice 5: only the read-only status snapshot is renderer-callable; lifecycle
        // (chatops.start/stop) and chatops.test stay off the Tauri surface (I7).
        assert!(is_method_allowed("chatops.status"));
        assert!(!is_method_allowed("chatops.start"));
        assert!(!is_method_allowed("chatops.stop"));
        assert!(!is_method_allowed("chatops.test"));
    }

    #[test]
    fn allowlist_tribal_read_only() {
        // Slice 6c: only the read-only status + list are renderer-callable; control-plane /
        // mutating ops (start/stop/dismiss/scan/capture) stay CLI-only, off the Tauri surface (I7).
        assert!(is_method_allowed("tribal.status"));
        assert!(is_method_allowed("tribal.list"));
        assert!(!is_method_allowed("tribal.start"));
        assert!(!is_method_allowed("tribal.stop"));
        assert!(!is_method_allowed("tribal.dismiss"));
        assert!(!is_method_allowed("tribal.scan"));
        assert!(!is_method_allowed("tribal.capture"));
    }

    #[test]
    fn allowlist_egress_read_only() {
        // Egress Ledger: only the 4 read verbs are renderer-callable; egress.prune
        // is a mutation and must never be reachable from the renderer (I7).
        assert!(is_method_allowed("egress.head"));
        assert!(is_method_allowed("egress.list"));
        assert!(is_method_allowed("egress.verify"));
        assert!(is_method_allowed("egress.proveWindow"));
        assert!(!is_method_allowed("egress.prune"));
    }

    #[test]
    fn allowlist_decisions_brief_only() {
        // S1 decisions: the read-only brief is renderer-callable; the maintenance
        // verbs that rewrite the decision store are not (I7). decisions.rebuild in
        // particular CLEARS every extracted and vetoed row, and both verbs are
        // LAN-forbidden, so neither may reach the renderer.
        //
        // Named explicitly on purpose: allowlist_exact_size alone would stay green
        // if a later change swapped agents.decisions out for decisions.refresh,
        // since the count is unchanged by a one-for-one substitution.
        assert!(is_method_allowed("agents.decisions"));
        assert!(!is_method_allowed("decisions.refresh"));
        assert!(!is_method_allowed("decisions.rebuild"));
    }

    #[test]
    fn allowlist_ownership_brief_only() {
        // S1 ownership: the read-only brief is renderer-callable; the maintenance verb that
        // re-derives the graph is not (I7). ownership.refresh clears and re-emits every
        // ownership edge wholesale, and is LAN-forbidden, so it must not reach the renderer.
        //
        // Named explicitly for the same reason as the decisions test above: allowlist_exact_size
        // alone stays green if a later change swaps agents.ownership out for ownership.refresh,
        // since the count is unchanged by a one-for-one substitution.
        assert!(is_method_allowed("agents.ownership"));
        assert!(!is_method_allowed("ownership.refresh"));
    }

    #[test]
    fn allowlist_negotiate_brief_only() {
        // S1 negotiate: the contribution brief is renderer-callable — the Tauri renderer is a
        // same-machine, owner-initiated surface, which is I7's threat model (renderer XSS), not
        // "arbitrary network caller". It has no maintenance verb to exclude: the agent is purely
        // read-only and writes nothing at all.
        //
        // Named explicitly for the same reason as the decisions/ownership tests above:
        // allowlist_exact_size alone stays green if a later change swaps agents.negotiate out
        // for some other method, since the count is unchanged by a one-for-one substitution.
        //
        // The exclusions this method DOES carry are enforced on the gateway side, not here:
        // agents.negotiate is absent from both the HTTP agent surface
        // (HTTP_EXCLUDED_AGENT_METHODS in ipc/agents-rpc.ts) and the MCP tool surface
        // (packages/cli/src/mcp/agent-tools.ts) — not for side effects, which it has none of,
        // but because --person makes it a dossier-builder for any bearer-token holder.
        assert!(is_method_allowed("agents.negotiate"));
    }

    #[test]
    fn allowlist_premortem_brief_only() {
        // S1 pre-mortem: the brief is renderer-callable; the maintenance verb that re-derives
        // the theme pass is not (I7). premortem.refresh has no rebuild counterpart and is
        // LAN-forbidden, so it must not reach the renderer.
        //
        // Unlike the sibling briefs above, agents.premortem is NOT purely read-only: it writes
        // paused (enabled = 0) watcher rows plus their proposal tombstones into local SQLite.
        // It qualifies under I7 all the same, because a paused row is inert until a human arms
        // it, and a local insert never reaches the executor's HITL gate. See
        // docs/SECURITY-INVARIANTS.md § I7.
        //
        // Named explicitly for the same reason as the decisions/ownership tests above:
        // allowlist_exact_size alone stays green if a later change swaps agents.premortem out
        // for premortem.refresh, since the count is unchanged by a one-for-one substitution.
        assert!(is_method_allowed("agents.premortem"));
        assert!(!is_method_allowed("premortem.refresh"));
    }

    #[test]
    fn allowlist_exact_size() {
        assert_eq!(ALLOWED_METHODS.len(), 106);
    }

    #[test]
    fn allowlist_is_alphabetized() {
        let mut sorted: Vec<&&str> = ALLOWED_METHODS.iter().collect();
        sorted.sort();
        let actual: Vec<&&str> = ALLOWED_METHODS.iter().collect();
        assert_eq!(actual, sorted, "ALLOWED_METHODS must be alphabetized");
    }

    #[test]
    fn allowlist_has_no_duplicates() {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for m in ALLOWED_METHODS {
            assert!(seen.insert(m), "duplicate method in ALLOWED_METHODS: {m}");
        }
    }

    #[test]
    fn allowlist_rejects_empty_and_unknown() {
        assert!(!is_method_allowed(""));
        assert!(!is_method_allowed("unknown.method"));
    }

    #[test]
    fn no_timeout_methods_contains_expected_five() {
        assert!(is_no_timeout_method("data.export"));
        assert!(is_no_timeout_method("data.import"));
        assert!(is_no_timeout_method("identity.login"));
        assert!(is_no_timeout_method("llm.pullModel"));
        assert!(is_no_timeout_method("updater.applyUpdate"));
        assert!(!is_no_timeout_method("profile.list"));
        assert!(!is_no_timeout_method("audit.list"));
    }

    #[test]
    fn no_timeout_methods_exact_size() {
        assert_eq!(NO_TIMEOUT_METHODS.len(), 5);
    }

    #[test]
    fn no_timeout_methods_are_subset_of_allowlist() {
        for m in NO_TIMEOUT_METHODS {
            assert!(
                is_method_allowed(m),
                "{m} is in NO_TIMEOUT_METHODS but not in ALLOWED_METHODS"
            );
        }
    }

    #[test]
    fn profile_switched_is_classified_for_global_rebroadcast() {
        assert!(is_global_broadcast_method("profile.switched"));
        assert!(!is_global_broadcast_method("consent.request"));
        assert!(!is_global_broadcast_method("connector.healthChanged"));
    }

    #[test]
    fn global_broadcast_methods_exact_size() {
        assert_eq!(GLOBAL_BROADCAST_METHODS.len(), 1);
    }
}

use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub async fn shell_start_gateway(app: AppHandle) -> Result<(), String> {
    app.shell()
        .command("nimbus")
        .args(["start"])
        .spawn()
        .map(|_child| ())
        .map_err(|e| format!("Failed to launch nimbus: {e} (is it on PATH?)"))
}

#[tauri::command]
pub async fn get_pending_hitl(state: State<'_, HitlInbox>) -> Result<Vec<PendingHitl>, String> {
    Ok(state.snapshot())
}

#[tauri::command]
pub async fn hitl_resolved(
    app: AppHandle,
    state: State<'_, HitlInbox>,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    state.remove(&request_id);
    let _ = app.emit(
        "consent://resolved",
        json!({ "request_id": request_id, "approved": approved }),
    );
    Ok(())
}

fn classify_notification(app: &AppHandle, method: &str, params: Option<&Value>) {
    match method {
        "consent.request" => {
            let Some(params) = params else {
                return;
            };
            let (Some(request_id), Some(prompt)) = (
                params
                    .get("requestId")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                params
                    .get("prompt")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            ) else {
                return;
            };
            let received_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let details = params.get("details").cloned();
            let record = PendingHitl {
                request_id,
                prompt,
                details,
                received_at_ms,
            };
            if let Some(inbox) = app.try_state::<HitlInbox>() {
                if inbox.push_dedup(record.clone()) {
                    let _ = app.emit("consent://request", &record);
                    let _ = crate::hitl_popup::open_or_focus(app);
                }
            }
        }
        "connector.healthChanged" => {
            if let Some(p) = params.cloned() {
                let _ = app.emit("connector://health-changed", p);
            }
        }
        "profile.switched" => {
            if let Some(p) = params.cloned() {
                let _ = app.emit("profile://switched", p);
            }
        }
        _ => {}
    }
}
