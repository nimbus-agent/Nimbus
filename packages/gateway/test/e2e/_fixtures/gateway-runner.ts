// E2E gateway runner — boots a REAL gateway (assemblePlatformServices + IPC start, the same
// boot path as src/index.ts) in a subprocess, with paths + fixtures injected via env:
//   NIMBUS_E2E_PATHS_JSON      — PlatformPaths (temp dirs + unique socket/pipe)
//   NIMBUS_E2E_SEED_VAULT_JSON — vault key→value seeds (bot tokens, mock oauth), written BEFORE
//                                assembly so the ChatOps auto-start finds them
//   NIMBUS_E2E_SEED_SCIM_JSON  — SCIM users [{externalId,userName,email,active}] + the active
//                                operator session for [identity].issuer, seeded AFTER assembly
// The engine read path is bound to a deterministic stub: this harness proves the CHATOPS wiring
// (transports → identity → policy → HITL gate → dispatch → reply), not the LLM.

import { loadNimbusIdentityFromConfigDir } from "../../../src/config/nimbus-toml.ts";
import { IdentityStore } from "../../../src/identity/identity-store.ts";
import { assemblePlatformServices } from "../../../src/platform/assemble.ts";
import type { PlatformPaths } from "../../../src/platform/paths.ts";
import { createNimbusVault } from "../../../src/vault/factory.ts";

function envJson<T>(name: string): T | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return JSON.parse(raw) as T;
}

const paths = envJson<PlatformPaths>("NIMBUS_E2E_PATHS_JSON");
if (paths === undefined) {
  process.stderr.write("[e2e-runner] NIMBUS_E2E_PATHS_JSON is required\n");
  process.exit(1);
}

// Seed the vault BEFORE assembly (same backing store the gateway opens).
const vaultSeeds = envJson<Record<string, string>>("NIMBUS_E2E_SEED_VAULT_JSON") ?? {};
{
  const seedVault = await createNimbusVault(paths);
  for (const [key, value] of Object.entries(vaultSeeds)) {
    await seedVault.set(key, value);
  }
}

const services = await assemblePlatformServices(paths);

// Seed SCIM users + an active operator session for the configured issuer (I18 inputs).
interface ScimSeed {
  externalId: string;
  userName: string;
  email: string;
  active: boolean;
}
const scimSeeds = envJson<ScimSeed[]>("NIMBUS_E2E_SEED_SCIM_JSON") ?? [];
if (scimSeeds.length > 0) {
  const db = services.localIndex.getDatabase();
  const store = new IdentityStore(db);
  const now = Date.now();
  for (const u of scimSeeds) {
    store.upsertScimUser(
      {
        externalId: u.externalId,
        userName: u.userName,
        email: u.email,
        active: u.active,
        attrs: {},
      },
      now,
    );
  }
  const identityCfg = loadNimbusIdentityFromConfigDir(paths.configDir);
  if (identityCfg.enabled && identityCfg.issuer !== "") {
    store.upsertSession({
      issuer: identityCfg.issuer,
      externalId: "e2e-operator",
      email: "operator@acme.com",
      validatedAt: now,
      expiresAt: now + 60 * 60 * 1000,
      status: "active",
    });
  }
}

// Seed tribal clusters (Slice 6c e2e): lets a test exercise the IPC capture/list/dismiss surface
// without a live embedding run. Inserted directly into the V39 ledger.
interface TribalSeed {
  clusterId: string;
  question: string;
  channelId: string;
  platform?: string;
  occurrenceCount?: number;
}
const tribalSeeds = envJson<TribalSeed[]>("NIMBUS_E2E_SEED_TRIBAL_JSON") ?? [];
if (tribalSeeds.length > 0) {
  const db = services.localIndex.getDatabase();
  const now = Date.now();
  for (const c of tribalSeeds) {
    db.run(
      `INSERT OR REPLACE INTO tribal_clusters
         (cluster_id, representative_question, occurrence_count, first_seen, last_seen, status, channel_id, platform)
       VALUES (?, ?, ?, ?, ?, 'suggested', ?, ?)`,
      [
        c.clusterId,
        c.question,
        c.occurrenceCount ?? 3,
        now,
        now,
        c.channelId,
        c.platform ?? "slack",
      ],
    );
  }
}

// Seed session-memory turns (Slice 8 share e2e): the share-gate's collectSession reads turns from
// the session_memory store. With NIMBUS_SKIP_EMBEDDING_RUNTIME=1 the store has no embedding vector,
// so rows carry vec_rowid 0 (the store's own no-vec sentinel) — getRecentTurns reads
// chunk_text/role/created_at only.
interface SessionTurnSeed {
  sessionId: string;
  role: "user" | "assistant";
  text: string;
}
const sessionSeeds = envJson<SessionTurnSeed[]>("NIMBUS_E2E_SEED_SESSION_JSON") ?? [];
if (sessionSeeds.length > 0) {
  const db = services.localIndex.getDatabase();
  let now = Date.now();
  for (const t of sessionSeeds) {
    db.run(
      `INSERT INTO session_memory (session_id, chunk_text, vec_rowid, role, created_at)
       VALUES (?, ?, 0, ?, ?)`,
      [t.sessionId, t.text, t.role, now],
    );
    now += 1; // keep insertion order stable for getRecentTurns' created_at ordering
  }
}

// Deterministic engine stub for the chatops read path (see header note). The connector tool
// layer is the file-backed sink (NIMBUS_CHATOPS_E2E_SINK_DIR, set by the test) — assemble.ts
// swaps the real bot-spawn + mesh dispatch for it, so this gateway exercises the full chatops
// WIRING (IPC, signed policy, SCIM, executor HITL gate, audit chain, I23) against a mock transport.
services.chatops?.bindAskEngine((query, namespace) =>
  Promise.resolve(`[${namespace}] oncall = alice (stub-engine answer to: ${query})`),
);

const shutdown = (): void => {
  try {
    services.disposeSidecars?.();
  } catch {
    /* ignore */
  }
  void services.ipc
    .stop()
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await services.ipc.start();
process.stdout.write(`[gateway] ready (e2e) IPC ${paths.socketPath}\n`);
