/**
 * COMMAND_MANIFEST — data-only registry of every user-facing CLI command.
 *
 * The cli-conventions-gate test derives EVERYTHING from this file:
 *   - structural invariants (≤1 positional attribute per canonical form,
 *     legacyPositionalProject ⇒ projectScoped, ...);
 *   - behavioral `--project` acceptance for every projectScoped entry;
 *   - behavioral `--json` acceptance for every entry;
 *   - completeness against cli.mjs's dispatch switch.
 *
 * Entry shape:
 *   path                   argv words, e.g. ["secrets", "set"]
 *   positionals            canonical positional ATTRIBUTES (post-conventions).
 *                          A variadic list of the SAME kind counts as one.
 *   projectScoped          command operates on a project and accepts
 *                          `--project <id>` (precedence: --project > legacy
 *                          leading prj_ positional > active project)
 *   orgScoped              command acts ON an organization and resolves it
 *                          through the ONE shared chain (cli-org-context):
 *                          an optional leading <org_id> positional, else
 *                          --org, else RUN402_ORG, else the .run402.json
 *                          binding, else `org use`. The gate drives every
 *                          such entry through --org AND RUN402_ORG with no
 *                          positional and fails on any "Missing <org_id>".
 *                          Any entry with an `org_id` positional MUST be
 *                          orgScoped and that positional MUST be optional.
 *   legacyPositionalProject  still accepts the legacy leading `prj_...`
 *                          positional project selector (compat, no warning)
 *   minimalArgs            args (beyond path) that satisfy LOCAL validation
 *                          for the gate's behavioral flag-acceptance runs.
 *                          Placeholders the gate substitutes at runtime:
 *                            __FIXTURE_FILE__  an existing regular file
 *                            __OUT_FILE__      a writable output file path
 *                            __SCRATCH_DIR__   an existing scratch directory
 *   runStyle               how the gate invokes the module (default "sub"):
 *                            "sub"      run(path[1], [...path.slice(2), ...argv])
 *                            "flat"     run([...path.slice(1), ...argv])
 *                            "merged"   run(argv[0], argv.slice(1))
 *                            "deployV2" runDeployV2(path[1], [...path.slice(2), ...argv])
 *   skipBehavioral         optional string reason — the command is interactive,
 *                          long-running, or has cwd side effects that make an
 *                          in-process behavioral run unsafe. Structural
 *                          invariants still apply.
 *
 * Keep it honest: if a command's canonical form cannot satisfy the ≤1
 * positional rule, fix the command (add flag alternatives), don't fudge the
 * manifest.
 */

const p = (name, { required = true, variadic = false } = {}) => ({ name, required, variadic });

/**
 * The org id the gate uses for every orgScoped entry — a well-formed UUID so
 * the shared resolver accepts it from any rung (positional, --org, RUN402_ORG).
 * The behavioral org-scope gate strips it from minimalArgs and re-supplies the
 * org through each rung in turn.
 */
export const GATE_ORG = "11111111-2222-3333-4444-555555555555";

export const COMMAND_MANIFEST = [
  // ── external agent identity links ────────────────────────────────────────
  { path: ["identity", "link", "nostr", "begin"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--pubkey", "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa", "--visibility", "public"], skipBehavioral: "requires a live wallet and gateway challenge" },
  { path: ["identity", "link", "nostr", "complete"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--event-file", "__FIXTURE_FILE__"], skipBehavioral: "requires a valid live signed Nostr challenge event" },
  { path: ["identity", "link", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], skipBehavioral: "requires live wallet authentication" },
  { path: ["identity", "link", "show"], positionals: [p("identity_link_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["idlnk_11111111111111111111111111111111"], skipBehavioral: "requires a live public proof" },
  { path: ["identity", "link", "revoke"], positionals: [p("identity_link_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["idlnk_11111111111111111111111111111111"], skipBehavioral: "requires a live linked identity" },

  // ── Buzz community ↔ Run402 control plane ───────────────────────────────
  { path: ["buzz", "status"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], skipBehavioral: "requires live principal authentication" },
  { path: ["buzz", "adopt", "offer"], positionals: [], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: ["--identity-link", "idlnk_11111111111111111111111111111111"], skipBehavioral: "requires eligible sole agent owner, live Buzz identity, and offer-capable gateway" },
  { path: ["buzz", "adopt", "direct"], positionals: [], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: ["--identity-link", "idlnk_11111111111111111111111111111111"], skipBehavioral: "advanced compatibility flow requiring eligible sole agent owner and live Buzz identity" },
  { path: ["buzz", "install"], positionals: [], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: ["--community", "buzz:community:relay.example", "--authority", "11".repeat(32)], skipBehavioral: "requires owner step-up and a compatible live Buzz relay" },
  { path: ["buzz", "enroll"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--installation", "buzzci_11111111111111111111111111111111", "--identity-link", "idlnk_11111111111111111111111111111111", "--grants-file", "__FIXTURE_FILE__", "--expires-at", "2026-08-01T00:00:00.000Z"], skipBehavioral: "requires live relay membership evidence and a grant fixture" },
  { path: ["buzz", "approve"], positionals: [p("buzz_agent_enrollment_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzae_11111111111111111111111111111111", "--grants-file", "__FIXTURE_FILE__", "--descriptor-revision", "1", "--policy-revision", "1"], skipBehavioral: "requires owner step-up and a live pending enrollment" },
  { path: ["buzz", "deny"], positionals: [p("buzz_agent_enrollment_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzae_11111111111111111111111111111111"], skipBehavioral: "requires owner step-up and a live pending enrollment" },
  { path: ["buzz", "revoke"], positionals: [p("buzz_agent_enrollment_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzae_11111111111111111111111111111111"], skipBehavioral: "requires a live enrollment" },
  // Project-event routing into a Buzz channel (add-buzz-project-event-routing).
  // org ids on this surface are BARE dashed UUIDs, never org_-prefixed.
  { path: ["buzz", "notifications", "configure"], positionals: [], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: ["--installation", "buzzci_11111111111111111111111111111111", "--name", "deploys", "--channel", "22222222-2222-4222-8222-222222222222"], skipBehavioral: "requires live owner authentication and an active Buzz installation (and its repeatable --project scope flag is reserved by the gate)" },
  { path: ["buzz", "notifications", "status"], positionals: [p("buzz_project_event_route_id", { required: false })], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--org", "11111111-1111-4111-8111-111111111111"], skipBehavioral: "requires live owner authentication" },
  { path: ["buzz", "notifications", "test"], positionals: [p("buzz_project_event_route_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzper_11111111111111111111111111111111"], skipBehavioral: "requires live owner authentication and a live route" },
  { path: ["buzz", "notifications", "deliveries"], positionals: [p("buzz_project_event_route_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzper_11111111111111111111111111111111"], skipBehavioral: "requires live owner authentication and a live route" },
  { path: ["buzz", "notifications", "pause"], positionals: [p("buzz_project_event_route_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzper_11111111111111111111111111111111"], skipBehavioral: "requires live owner authentication and a live route" },
  { path: ["buzz", "notifications", "resume"], positionals: [p("buzz_project_event_route_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzper_11111111111111111111111111111111"], skipBehavioral: "requires live owner authentication and a live route" },
  { path: ["buzz", "notifications", "rotate"], positionals: [p("buzz_project_event_route_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzper_11111111111111111111111111111111"], skipBehavioral: "requires live owner authentication and a live route" },
  { path: ["buzz", "notifications", "revoke"], positionals: [p("buzz_project_event_route_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["buzzper_11111111111111111111111111111111"], skipBehavioral: "requires live owner authentication and a live route" },

  // ── up / init / status (flat runners) ────────────────────────────────────
  { path: ["up"], positionals: [p("source", { required: false })], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--check", "-y"], runStyle: "flat", skipBehavioral: "orchestrates a full provision/build/deploy against the real cwd" },
  { path: ["up", "verify"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "flat", skipBehavioral: "polls live edge coherence" },
  { path: ["init"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "flat", skipBehavioral: "creates a wallet and polls funding" },
  { path: ["pay"], positionals: [p("url")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["https://example.com/"], runStyle: "flat", skipBehavioral: "calls an external URL and may authorize an x402 payment" },
  { path: ["status"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "flat" },
  { path: ["redeem"], positionals: [p("code")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["R402-K8F3-Q2W9"], runStyle: "flat", skipBehavioral: "credits real money against the live organization" },

  // ── wallets ──────────────────────────────────────────────────────────────
  { path: ["wallets", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["wallets", "current"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["wallets", "new"], positionals: [p("name")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["gate-test-wallet"] },
  { path: ["wallets", "use"], positionals: [p("name")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["default"] },
  { path: ["wallets", "rename"], positionals: [p("old_name")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["no-such-wallet", "--to", "still-no-such"] },
  { path: ["wallets", "bind"], positionals: [p("name", { required: false })], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["wallets", "unbind"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["wallets", "import"], positionals: [p("name")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["gate-import-wallet", "--key", "__FIXTURE_FILE__"] },
  { path: ["wallets", "rm"], positionals: [p("name")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["no-such-wallet", "--yes"] },

  // ── credentials (gateway project credentials) ────────────────────────────
  { path: ["credentials", "issue"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--kind", "service", "--name", "gate-cred"] },
  { path: ["credentials", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["credentials", "status"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["credentials", "rotate"], positionals: [p("credential_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["pcr_gate1"] },
  { path: ["credentials", "revoke"], positionals: [p("credential_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["pcr_gate1"] },
  { path: ["credentials", "token"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },

  // ── credentials (project-keys group) ─────────────────────────────────────
  { path: ["credentials", "project-keys", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["credentials", "project-keys", "status"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["credentials", "project-keys", "import"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--service-key-env", "RUN402_GATE_FAKE_SERVICE_KEY"] },
  { path: ["credentials", "project-keys", "export"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--reveal"] },
  { path: ["credentials", "project-keys", "remove"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },

  // ── allowance ────────────────────────────────────────────────────────────
  { path: ["allowance", "status"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["allowance", "create"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], skipBehavioral: "creates a real local wallet key outside the gate's scratch profile" },
  { path: ["allowance", "fund"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], skipBehavioral: "polls on-chain funding with sleeps" },
  { path: ["allowance", "balance"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["allowance", "export"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["allowance", "checkout"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--amount", "5000000"] },
  { path: ["allowance", "history"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },

  // ── tier ─────────────────────────────────────────────────────────────────
  { path: ["tier", "status"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["tier", "set"], positionals: [p("tier")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["prototype"] },

  // ── projects ─────────────────────────────────────────────────────────────
  { path: ["projects", "quote"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["projects", "provision"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["projects", "use"], positionals: [p("project_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["prj_test123"] },
  { path: ["projects", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["projects", "current"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["projects", "rename"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["--name", "Gate Name"] },
  { path: ["projects", "tenant-payments"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["projects", "get"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["projects", "sql"], positionals: [p("query", { required: false })], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["SELECT 1"] },
  { path: ["projects", "rest"], positionals: [p("table")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["users"] },
  { path: ["projects", "usage"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["projects", "costs"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["projects", "schema"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["projects", "apply-expose"], positionals: [p("manifest_json", { required: false })], projectScoped: true, legacyPositionalProject: true, minimalArgs: ['{"version":"1","tables":[]}'] },
  { path: ["projects", "validate-expose"], positionals: [p("manifest_json", { required: false })], projectScoped: true, legacyPositionalProject: true, minimalArgs: ['{"version":"1","tables":[]}'] },
  { path: ["projects", "get-expose"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["projects", "delete"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["projects", "promote-user"], positionals: [p("email")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["user@example.com"] },
  { path: ["projects", "demote-user"], positionals: [p("email")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["user@example.com"] },
  { path: ["projects", "export"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },

  // ── snapshots ────────────────────────────────────────────────────────────
  { path: ["snapshots", "create"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["snapshots", "list"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["snapshots", "get"], positionals: [p("snapshot_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["snap_gate1"] },
  { path: ["snapshots", "restore"], positionals: [p("snapshot_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["snap_gate1"] },
  { path: ["snapshots", "delete"], positionals: [p("snapshot_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["snap_gate1"] },

  // ── branches ─────────────────────────────────────────────────────────────
  { path: ["branches", "create"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["branches", "list"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["branches", "renew"], positionals: [p("branch_project_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["prj_branch1"] },
  { path: ["branches", "delete"], positionals: [p("branch_project_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["prj_branch1"] },

  // ── admin ────────────────────────────────────────────────────────────────
  { path: ["admin", "lease-perpetual"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--enable"] },
  { path: ["admin", "archive"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["--reason", "gate"] },
  { path: ["admin", "reactivate"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },

  // ── cloud / archives / core ──────────────────────────────────────────────
  { path: ["cloud", "archives", "create"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["cloud", "archives", "download"], positionals: [p("archive_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["arc_gate1", "--output", "__OUT_FILE__"] },
  { path: ["cloud", "archives", "status"], positionals: [p("archive_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["arc_gate1"] },
  { path: ["archives", "inspect"], positionals: [p("archive_path")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["__FIXTURE_FILE__"] },
  { path: ["archives", "verify"], positionals: [p("archive_path")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["__FIXTURE_FILE__"] },
  { path: ["core", "projects", "import"], positionals: [p("archive_path")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["__FIXTURE_FILE__", "--name", "gate-import"] },

  // ── deploy (unified deploy v2) ───────────────────────────────────────────
  { path: ["deploy", "apply"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--spec", "{}", "--check"], runStyle: "deployV2" },
  { path: ["deploy", "rehearse"], positionals: [p("plan_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["plan_gate1"], runStyle: "deployV2" },
  { path: ["deploy", "promote"], positionals: [p("release_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["rel_gate1"], runStyle: "deployV2" },
  { path: ["deploy", "resume"], positionals: [p("operation_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["op_gate1"], runStyle: "deployV2" },
  { path: ["deploy", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "deployV2" },
  { path: ["deploy", "events"], positionals: [p("operation_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["op_gate1"], runStyle: "deployV2" },
  { path: ["deploy", "verify"], positionals: [p("operation_id", { required: false })], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["op_gate1"], runStyle: "deployV2" },
  { path: ["deploy", "release", "get"], positionals: [p("release_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["rel_gate1"], runStyle: "deployV2" },
  { path: ["deploy", "release", "active"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "deployV2" },
  { path: ["deploy", "release", "diff"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--from", "empty", "--to", "active"], runStyle: "deployV2" },
  { path: ["deploy", "diagnose"], positionals: [p("url")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["https://example.com/"], runStyle: "deployV2" },
  { path: ["deploy", "resolve"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--url", "https://example.com/"], runStyle: "deployV2" },

  // ── ci ───────────────────────────────────────────────────────────────────
  { path: ["ci", "link"], positionals: [p("provider")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["github"] },
  { path: ["ci", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["ci", "revoke"], positionals: [p("binding_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["bnd_gate1"] },
  { path: ["ci", "set-asset-scopes"], positionals: [p("binding_id_and_scopes", { variadic: true })], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["bnd_gate1", "astro/*"] },

  // ── transfer ─────────────────────────────────────────────────────────────
  { path: ["transfer", "init"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--to", "0x1111111111111111111111111111111111111111"] },
  { path: ["transfer", "preview"], positionals: [p("transfer_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["tr_gate1"] },
  { path: ["transfer", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["transfer", "accept"], positionals: [p("transfer_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["tr_gate1"] },
  { path: ["transfer", "claim"], positionals: [p("transfer_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["tr_gate1"] },
  { path: ["transfer", "cancel"], positionals: [p("transfer_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["tr_gate1"] },

  // ── org ──────────────────────────────────────────────────────────────────
  { path: ["org", "create"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["org", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["org", "get"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG] },
  { path: ["org", "rename"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "--name", "Gate"] },
  { path: ["org", "payout-wallet"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "0x1111111111111111111111111111111111111111"] },
  // `--org` (not a positional org_id
  // like rename/payout-wallet above) goes through resolveOrg's SHAPE
  // validation (a real UUID) — "org_gate1" fails that locally, so this needs
  // the same UUID-shaped fixture `org use` below already established.
  { path: ["org", "slug"], positionals: [p("slug")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["acme", "--org", "11111111-2222-3333-4444-555555555555"] },
  { path: ["org", "whoami"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["org", "audit"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG] },
  { path: ["org", "use"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["11111111-2222-3333-4444-555555555555"] },
  { path: ["org", "current"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["org", "clear"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["org", "bind"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--org", "11111111-2222-3333-4444-555555555555"] },
  { path: ["org", "unbind"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["org", "member", "list"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG] },
  { path: ["org", "member", "add"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "0x1111111111111111111111111111111111111111"] },
  { path: ["org", "member", "role"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "--principal", "prn_gate1", "--role", "viewer"] },
  { path: ["org", "member", "rm"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "--principal", "prn_gate1"] },
  { path: ["org", "invite", "list"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG] },
  { path: ["org", "invite", "create"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "--email", "gate@example.com"] },
  { path: ["org", "invite", "rm"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "--principal", "prn_gate1"] },

  // ── grants ───────────────────────────────────────────────────────────────
  { path: ["grants", "create"], positionals: [p("wallet")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["0x1111111111111111111111111111111111111111", "--capability", "deploy"] },
  { path: ["grants", "revoke"], positionals: [p("grant_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["grt_gate1"] },

  // ── delegates ────────────────────────────────────────────────────────────
  { path: ["delegates", "create"], legacyPositionalProject: false, positionals: [], projectScoped: true, minimalArgs: ["--grant", "11111111-1111-1111-1111-111111111111"] },
  { path: ["delegates", "list"], legacyPositionalProject: false, positionals: [], projectScoped: true, minimalArgs: [] },
  { path: ["delegates", "revoke"], legacyPositionalProject: false, positionals: [p("delegate_id")], projectScoped: true, minimalArgs: ["dlg_gate1"] },
  { path: ["delegates", "rotate"], legacyPositionalProject: false, positionals: [p("delegate_id")], projectScoped: true, minimalArgs: ["dlg_gate1"] },

  // ── events / errors (flat, merged runners) ───────────────────────────────
  { path: ["events"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "merged" },
  { path: ["deliveries", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["deliveries", "get"], positionals: [p("notification_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["n_1"], runStyle: "sub" },
  { path: ["contacts", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["contacts", "add"], positionals: [p("email")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["a@b.co"], runStyle: "sub" },
  { path: ["contacts", "connect"], positionals: [p("channel")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["telegram"], runStyle: "sub" },
  { path: ["contacts", "rm"], positionals: [p("contact_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["c_1"], runStyle: "sub" },
  { path: ["contacts", "test"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["contacts", "preferences"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["subscriptions", "add"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["subscriptions", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["subscriptions", "rm"], positionals: [p("subscription_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["r_1"], runStyle: "sub" },
  { path: ["rooms", "join"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["rooms", "leave"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["messages", "send"], positionals: [p("body")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["hello"], runStyle: "sub" },
  { path: ["messages", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["messages", "get"], positionals: [p("message_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["msg_1"], runStyle: "sub" },
  { path: ["messages", "ack"], positionals: [p("message_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["msg_1"], runStyle: "sub" },
  { path: ["escalations", "raise"], positionals: [p("reason")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["a human is needed"], runStyle: "sub" },
  { path: ["escalations", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["escalations", "get"], positionals: [p("escalation_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["esc_1"], runStyle: "sub" },
  { path: ["escalations", "ack"], positionals: [p("escalation_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["esc_1"], runStyle: "sub" },
  { path: ["escalations", "resolve"], positionals: [p("escalation_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["esc_1"], runStyle: "sub" },
  { path: ["claims", "create"], positionals: [p("resource")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["deploy"], runStyle: "sub" },
  { path: ["claims", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub" },
  { path: ["claims", "release"], positionals: [p("claim_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["clm_1"], runStyle: "sub" },

  // ── gitvault — no manifest entries ──────────────────────
  // `cli/lib/gitvault.mjs`'s dispatcher handles every `gitvault <verb>` and
  // answers a structural COMMAND_MOVED (or, for `push`/`reconcile`,
  // COMMAND_REMOVED) redirect that dispatches nothing — see
  // RESERVED_SUBCOMMANDS below, and "gitvault" in SKIPPED_FAMILIES.

  // ── repos (the consolidated 15-verb family) ─
  // Every verb needs a real principal keystore and, for most, an allocated
  // repo and a local git working tree, so the gate runs structural checks
  // only — an in-process behavioral run would either no-op against the
  // universal `{}` fetch mock or touch the gate's own checkout.
  { path: ["repos", "create"], positionals: [p("name", { required: false })], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["my-notes"], runStyle: "sub", skipBehavioral: "provisions a project, allocates a repo, and scaffolds a real git remote into cwd" },
  { path: ["repos", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "reads the live bulk vaults-by-org route, or falls back to a live per-project walk" },
  { path: ["repos", "view"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "reads the local principal keystore and the live repo record" },
  // (`gh repo rename`): claims/renames the per-org-unique address-form
  // name, with `--repo`/`--project` addressing.
  { path: ["repos", "rename"], positionals: [p("new_name")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["my-notes"], runStyle: "sub", skipBehavioral: "claims a per-org-unique repo name against a live project" },
  { path: ["repos", "delete"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [], runStyle: "sub", skipBehavioral: "irreversibly deletes a project after reading its live non-repo-resource state and vault generation count" },
  { path: ["repos", "snapshot"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "captures the cwd git working tree and publishes a signed head" },
  // kygit-handoff: `handoff` captures a stash-shaped checkpoint and mints a
  // single-use bearer key through a live gateway call; `resume` claims one
  // (a real membership mutation) and writes into a fresh working tree.
  { path: ["repos", "handoff"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "captures the cwd git working tree and mints a single-use bearer key against a live vault — never run against the gate's own checkout" },
  { path: ["repos", "resume"], positionals: [p("key")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["kgh1_0000000000000000000000000000000000000000000000000000000000000000"], runStyle: "sub", skipBehavioral: "claims a live handoff (a real org-membership mutation) and clones a fresh working tree" },
  { path: ["repos", "policy"], positionals: [p("repos_policy")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["required"], runStyle: "sub", skipBehavioral: "owner + step-up mutation of the live project's activation policy" },
  // ONE flag-driven verb; `<destination>` is a real attribute (not a
  // sub-verb literal), so this stays a single manifest entry.
  { path: ["repos", "mirror"], positionals: [p("destination", { required: false })], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "reads/writes mirror destination config beside the keystore and may move real bytes into a customer-owned bucket" },
  { path: ["repos", "fsck"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "walks the live head chain and materializes the ref map against the keystore's local pins" },
  { path: ["repos", "gc"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "publishes a checkpoint under a maintenance lease and materializes the live vault head to enumerate retention roots" },
  // `access repair`/`revoke-key`/`declare-exposure`/`sync` are nested
  // sub-verb literals — one manifest entry each, all dispatched through the
  // ONE `run("access", ...)` case in repos.mjs.
  { path: ["repos", "access"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "reads the live org encryption-key directory + vault envelope recipients" },
  { path: ["repos", "access", "repair"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--recipient-state-version", "0", "--recipient-revocation-version", "0"], runStyle: "sub", skipBehavioral: "owner+step-up-gated epoch rotation (D193-D203, rev 42) — samples a fresh epoch key and re-seals a live vault's recipients" },
  { path: ["repos", "access", "revoke-key"], positionals: [p("principal_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["prin_00000000000000000000000000000000"], runStyle: "sub", skipBehavioral: "owner+step-up-gated: declares a recipient's key revoked (org-scoped watermark) and drives a real epoch rotation off it" },
  { path: ["repos", "access", "declare-exposure"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "owner+step-up-gated: declares this vault's epoch secret exposed, forcing every subsequent ordinary push to refuse until a rotation lands" },
  { path: ["repos", "access", "sync"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "sub", skipBehavioral: "gitvault-multi-writer (rev 47): on-demand writer-admission reconcile — resolves pending candidates' signing keys via the live org encryption-key directory and publishes a real add_writer_key head per candidate" },
  { path: ["repos", "recover"], positionals: [p("source")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["s3://example-mirror-bucket", "--out", "__SCRATCH_DIR__/recover-out"], runStyle: "sub", skipBehavioral: "materializes a git repository from a mirror source, offline, with no server call" },
  // Principal-scoped (one bundle covers every vault you can read), so no
  // --project — deliberately unlike its eleven vault-scoped siblings.
  { path: ["repos", "recovery-bundle"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--out", "-"], runStyle: "sub", skipBehavioral: "exports the caller's live member recovery bundle (stamps recovery-posture export evidence server-side)" },
  { path: ["errors"], positionals: [p("fingerprint_id", { required: false })], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "merged" },

  // ── jobs ─────────────────────────────────────────────────────────────────
  { path: ["jobs", "submit"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--file", "__FIXTURE_FILE__"] },
  { path: ["jobs", "get"], positionals: [p("job_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["job_gate1"] },
  { path: ["jobs", "logs"], positionals: [p("job_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["job_gate1"] },
  { path: ["jobs", "cancel"], positionals: [p("job_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["job_gate1"] },
  { path: ["jobs", "purge"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["jobs", "artifacts", "get"], positionals: [p("job_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["job_gate1", "--file", "result.json", "--output", "__OUT_FILE__"] },

  // ── functions ────────────────────────────────────────────────────────────
  { path: ["functions", "deploy"], positionals: [p("name")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn", "--file", "__FIXTURE_FILE__"] },
  { path: ["functions", "invoke"], positionals: [p("name")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn"] },
  { path: ["functions", "logs"], positionals: [p("name")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn"] },
  { path: ["functions", "update"], positionals: [p("name")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn", "--timeout", "5"] },
  { path: ["functions", "rebuild"], positionals: [p("name", { required: false })], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn"] },
  { path: ["functions", "list"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["functions", "delete"], positionals: [p("name")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn"] },
  { path: ["functions", "runs", "create"], positionals: [p("function_name")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn", "--event-type", "gate.test", "--idempotency-key", "gate:1"] },
  { path: ["functions", "runs", "list"], positionals: [p("function_name")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["gate-fn"] },
  { path: ["functions", "runs", "get"], positionals: [p("run_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["fnrun_gate1"] },
  { path: ["functions", "runs", "logs"], positionals: [p("run_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["fnrun_gate1"] },
  { path: ["functions", "runs", "cancel"], positionals: [p("run_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["fnrun_gate1"] },
  { path: ["functions", "runs", "redrive"], positionals: [p("run_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["fnrun_gate1"] },

  // ── secrets ──────────────────────────────────────────────────────────────
  { path: ["secrets", "set"], positionals: [p("key")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["MY_KEY", "--value", "v"] },
  { path: ["secrets", "list"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["secrets", "delete"], positionals: [p("key")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["MY_KEY"] },

  // ── assets ───────────────────────────────────────────────────────────────
  { path: ["assets", "put"], positionals: [p("file", { variadic: true })], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["__FIXTURE_FILE__"] },
  { path: ["assets", "get"], positionals: [p("key")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["gate.txt", "--output", "__OUT_FILE__"] },
  { path: ["assets", "ls"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["assets", "rm"], positionals: [p("key")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["gate.txt"] },
  { path: ["assets", "sign"], positionals: [p("key")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["gate.txt"] },
  { path: ["assets", "diagnose"], positionals: [p("url")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["https://app.run402.com/_blob/gate.txt"] },

  // ── cdn ──────────────────────────────────────────────────────────────────
  { path: ["cdn", "wait-fresh"], positionals: [p("url")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["https://example.com/a.png", "--sha", "a".repeat(64), "--timeout", "1"] },

  // ── sites ────────────────────────────────────────────────────────────────
  { path: ["sites", "deploy"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--manifest", "__FIXTURE_FILE__"] },
  { path: ["sites", "deploy-dir"], positionals: [p("dir")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["__SCRATCH_DIR__"] },

  // ── subdomains ───────────────────────────────────────────────────────────
  { path: ["subdomains", "claim"], positionals: [p("name")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["gate-sub"] },
  { path: ["subdomains", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["subdomains", "delete"], positionals: [p("name")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["gate-sub", "--confirm"] },

  // ── domains ──────────────────────────────────────────────────────────────
  { path: ["domains", "connect"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com", "--web"] },
  { path: ["domains", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["domains", "status"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com"] },
  { path: ["domains", "dns"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com"] },
  { path: ["domains", "check"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com"] },
  { path: ["domains", "apply"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com"] },
  { path: ["domains", "repair"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com"] },
  { path: ["domains", "test-receive"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com", "--to", "inbox"] },
  { path: ["domains", "wait"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com", "--timeout-ms", "1", "--interval-ms", "1"] },
  { path: ["domains", "activate"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com"] },
  { path: ["domains", "disconnect"], positionals: [p("domain")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["example.com", "--confirm"] },

  // ── apps ─────────────────────────────────────────────────────────────────
  { path: ["apps", "browse"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["apps", "fork"], positionals: [p("version_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["ver_gate1", "--name", "gate-fork"] },
  { path: ["apps", "publish"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["apps", "versions"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["apps", "inspect"], positionals: [p("version_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["ver_gate1"] },
  { path: ["apps", "update"], positionals: [p("version_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["ver_gate1", "--description", "gate"] },
  { path: ["apps", "delete"], positionals: [p("version_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["ver_gate1"] },

  // ── ai / image ───────────────────────────────────────────────────────────
  { path: ["ai", "translate"], positionals: [p("text")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["hello", "--to", "fr"] },
  { path: ["ai", "moderate"], positionals: [p("text")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["hello"] },
  { path: ["ai", "usage"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["image", "generate"], positionals: [p("prompt")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["a gate mascot"] },

  // ── email (+ nested webhooks group) ──────────────────────────────────────
  { path: ["email", "create"], positionals: [p("slug")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["gate-slug"] },
  { path: ["email", "mailboxes"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["email", "defaults"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["email", "update"], positionals: [p("mailbox", { required: false })], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--footer-policy", "none"] },
  { path: ["email", "info"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["email", "send"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--to", "gate@example.com", "--subject", "gate", "--html", "<p>gate</p>"] },
  { path: ["email", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["email", "get"], positionals: [p("message_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["msg_gate1"] },
  { path: ["email", "get-raw"], positionals: [p("message_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["msg_gate1", "--output", "__OUT_FILE__"] },
  { path: ["email", "reply"], positionals: [p("message_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["msg_gate1", "--html", "<p>gate</p>"] },
  { path: ["email", "delete"], positionals: [p("mailbox", { required: false })], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--confirm"] },
  { path: ["email", "webhooks", "list"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["email", "webhooks", "get"], positionals: [p("webhook_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["whk_gate1"] },
  { path: ["email", "webhooks", "delete"], positionals: [p("webhook_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["whk_gate1"] },
  { path: ["email", "webhooks", "update"], positionals: [p("webhook_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["whk_gate1", "--url", "https://example.com/hook"] },
  { path: ["email", "webhooks", "register"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--url", "https://example.com/hook", "--events", "email.received"] },
  { path: ["email", "webhooks", "deliveries"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["email", "webhooks", "redrive"], positionals: [p("delivery_id")], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["dlv_gate1"] },

  // ── message / agent / operator ───────────────────────────────────────────
  { path: ["feedback", "send"], positionals: [p("words", { variadic: true })], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["hello", "from", "the", "gate"] },
  { path: ["agent", "contact"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--name", "gate-agent"] },
  { path: ["agent", "status"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["agent", "verify-email"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["agent", "passkey"], positionals: [p("action")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["enroll"] },
  { path: ["operator", "login"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], skipBehavioral: "opens a browser / loopback listener" },
  { path: ["operator", "logout"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["operator", "overview"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["operator", "whoami"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["operator", "claim-wallet-org"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["operator", "approve"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--action", "org.project.create", "--org", "org_gate1", "--no-open"] },

  // ── auth ─────────────────────────────────────────────────────────────────
  { path: ["auth", "magic-link"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--email", "gate@example.com", "--redirect", "https://example.com/cb"] },
  { path: ["auth", "verify"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--token", "tok_gate1"] },
  { path: ["auth", "create-user"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--email", "gate@example.com"] },
  { path: ["auth", "invite-user"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--email", "gate@example.com", "--redirect", "https://example.com/cb"] },
  { path: ["auth", "set-password"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--token", "tok_gate1", "--new", "gate-password"] },
  { path: ["auth", "settings"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["auth", "passkey-register-options"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--token", "tok_gate1", "--app-origin", "https://example.com"] },
  { path: ["auth", "passkey-register-verify"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--token", "tok_gate1", "--challenge", "ch_gate1", "--response", "{}"] },
  { path: ["auth", "passkey-login-options"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--app-origin", "https://example.com"] },
  { path: ["auth", "passkey-login-verify"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--challenge", "ch_gate1", "--response", "{}"] },
  { path: ["auth", "passkeys"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--token", "tok_gate1"] },
  { path: ["auth", "delete-passkey"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--token", "tok_gate1", "--id", "pk_gate1"] },
  { path: ["auth", "providers"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [] },

  // ── billing ──────────────────────────────────────────────────────────────
  { path: ["billing", "create-email"], positionals: [p("email")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["gate@example.com"] },
  { path: ["billing", "link-wallet"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "0x1111111111111111111111111111111111111111"] },
  { path: ["billing", "checkout"], positionals: [p("identifier")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["00000000-0000-4000-8000-000000000001", "--product", "email-pack"] },
  { path: ["billing", "auto-recharge"], positionals: [p("org_id", { required: false })], projectScoped: false, orgScoped: true, legacyPositionalProject: false, minimalArgs: [GATE_ORG, "--state", "on"] },
  { path: ["billing", "balance"], positionals: [p("identifier")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["gate@example.com"] },
  { path: ["billing", "history"], positionals: [p("identifier")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["gate@example.com"] },

  // ── contracts ────────────────────────────────────────────────────────────
  { path: ["contracts", "provision-signer"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["--chain", "base-sepolia", "--yes"] },
  { path: ["contracts", "get-signer"], positionals: [p("signer_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["cwlt_gate1"] },
  { path: ["contracts", "list-signers"], positionals: [], projectScoped: true, legacyPositionalProject: true, minimalArgs: [] },
  { path: ["contracts", "set-recovery"], positionals: [p("signer_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["cwlt_gate1", "--clear"] },
  { path: ["contracts", "set-alert"], positionals: [p("signer_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["cwlt_gate1", "--threshold-wei", "1"] },
  { path: ["contracts", "call"], positionals: [p("signer_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["cwlt_gate1", "--to", "0x4444444444444444444444444444444444444444", "--abi", "[]", "--fn", "noop", "--args", "[]"] },
  { path: ["contracts", "deploy"], positionals: [p("signer_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["cwlt_gate1", "--bytecode", "0x00"] },
  { path: ["contracts", "read"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--chain", "base-sepolia", "--to", "0x4444444444444444444444444444444444444444", "--abi", "[]", "--fn", "noop", "--args", "[]"] },
  { path: ["contracts", "status"], positionals: [p("call_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["ccall_gate1"] },
  { path: ["contracts", "drain"], positionals: [p("signer_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["cwlt_gate1", "--to", "0x4444444444444444444444444444444444444444", "--confirm"] },
  { path: ["contracts", "delete"], positionals: [p("signer_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["cwlt_gate1", "--confirm"] },

  // ── service / cache / doctor / notifications / webhook-secret / logs ─────
  { path: ["service", "status"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["service", "health"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["cache", "inspect"], positionals: [p("url")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["https://example.com/"] },
  { path: ["cache", "invalidate"], positionals: [p("url", { required: false })], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--all", "--host", "example.com"] },
  // projectScoped: --project targets the gitvault
  // check only (see doctor.mjs's own HELP) — every other check stays
  // wallet/machine-wide, but the gate's contract is "accepts --project
  // without rejecting it," which this satisfies.
  { path: ["doctor"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--no-scan"], runStyle: "merged" },
  { path: ["webhook-secret", "rotate"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["logs"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--request-id", "req_gate123"], runStyle: "merged" },
];

// Families deliberately absent from the manifest, consumed by the gate's
// completeness check against cli.mjs's dispatch switch.
export const SKIPPED_FAMILIES = {
  "apply": "pure alias for `deploy apply` (covered by the deploy family)",
  "dev": "interactive wrapper that spawns `astro dev`",
  // RESERVED, not dispatched: every `run402 message …` fails with
  // COMMAND_REMOVED pointing at `feedback send` / `messages send` /
  // `escalations raise`. It has no subcommands to manifest because it takes
  // none — the noun is being held for addressed agent/human messaging.
  "message": "reserved noun; fails with COMMAND_REMOVED (renamed to `feedback`)",
  // Split into `deliveries` / `contacts` / `subscriptions`; every subcommand
  // answers COMMAND_REMOVED naming its successor.
  "notifications": "reserved group; split by legible-cli-surface",
  // The gitvault dispatcher answers COMMAND_MOVED/COMMAND_REMOVED for every
  // `gitvault <verb>` (see RESERVED_SUBCOMMANDS below for the per-verb list)
  // — the family stays dispatched in cli.mjs (so the redirect fires instead
  // of UNKNOWN_COMMAND) but has zero manifest entries, since a redirect
  // dispatches nothing.
  "gitvault": "retired; every subcommand answers COMMAND_MOVED/COMMAND_REMOVED naming its `repos`/git successor",
  // Shipped in exactly one release (v4.54.0, live for hours) before the
  // one-noun review caught it: a gateway route namespace is not a CLI noun.
  // Both verbs answer COMMAND_MOVED into the repos family for one release,
  // then the spelling is reserved and answers nothing.
  "source-access": "retired same-day; `export` -> `repos recovery-bundle`, `status` -> `repos access` (member_custody block)",
  // `repo` singular resolves identically to `repos` — same
  // module, same case block in cli.mjs, so it needs no manifest of its own.
  "repo": "alias for `repos`, resolves identically (design D1)",
};

/**
 * SUBCOMMAND spellings kept alive only to answer `COMMAND_REMOVED`.
 *
 * A retired spelling still needs a `case` branch — that branch IS the redirect,
 * and without it a caller gets a generic "unknown subcommand" instead of being
 * told where the verb went. But it is not a command: it dispatches nothing and
 * belongs in no capability mapping, so the inventory gate must not demand one.
 *
 * The family-level equivalent is SKIPPED_FAMILIES above. This exists because
 * some spellings are retired INSIDE a family rather than as a whole family,
 * which the family list cannot express.
 */
export const RESERVED_SUBCOMMANDS = {
  "source-access:export": "moved to `repos recovery-bundle` — the artifact `repos recover --bundle` consumes belongs to the repos family",
  "source-access:status": "moved to `repos access` — your own wrapper custody rides its member_custody block; the org advisory is `doctor --only recovery_posture`",
  "rooms:who": "renamed to `rooms join` — an interrogative must not name a write",
  "rooms:send": "moved to `messages send` — the verb acts on a message",
  // The routes and SDK methods for room list/get exist (agent-room-lifecycle);
  // only these two SPELLINGS are held back, because they were freed from
  // meaning "list/get MESSAGES" and a reused spelling changes meaning without
  // ever failing. One major, then they may name the room.
  "rooms:list": "moved to `messages list` — the verb acts on a message",
  "rooms:get": "moved to `messages get` — the verb acts on a message",
  "rooms:ack": "moved to `messages ack` — the verb acts on a message",
  "escalations:contacts": "merged into `contacts` — the ladder and Telegram channels are one question",
  // Every `gitvault <verb>` spelling. Nine
  // answer COMMAND_MOVED naming their `repos` successor; `push` and
  // `reconcile` answer COMMAND_REMOVED (no equivalent successor for either —
  // `push`'s one-release alias window is over, `reconcile` was a workaround
  // with no permanent replacement, only a read at `repos access`).
  "gitvault:init": "moved to `repos create --project <id>`",
  "gitvault:status": "moved to `repos view`",
  "gitvault:snapshot": "moved to `repos snapshot`",
  "gitvault:policy": "moved to `repos policy`",
  "gitvault:compact": "moved to `repos gc`",
  "gitvault:prune": "moved to `repos gc`",
  "gitvault:verify": "moved to `repos fsck`",
  "gitvault:mirror": "moved to `repos mirror`",
  "gitvault:recover": "moved to `repos recover`",
  "gitvault:push": "removed — its one-release deprecation-alias window is over; `git push` / `repos snapshot`",
  "gitvault:reconcile": "removed — a workaround with no permanent successor; read `repos access` instead",
};
