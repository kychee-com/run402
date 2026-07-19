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

export const COMMAND_MANIFEST = [
  // ── up / init / status (flat runners) ────────────────────────────────────
  { path: ["up"], positionals: [p("source", { required: false })], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--check", "-y"], runStyle: "flat", skipBehavioral: "orchestrates a full provision/build/deploy against the real cwd" },
  { path: ["up", "verify"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "flat", skipBehavioral: "polls live edge coherence" },
  { path: ["init"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "flat", skipBehavioral: "creates a wallet and polls funding" },
  { path: ["status"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [], runStyle: "flat" },

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
  { path: ["org", "get"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1"] },
  { path: ["org", "rename"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--name", "Gate"] },
  { path: ["org", "payout-wallet"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--wallet", "0x1111111111111111111111111111111111111111"] },
  { path: ["org", "whoami"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["org", "audit"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1"] },
  { path: ["org", "member", "list"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1"] },
  { path: ["org", "member", "add"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--wallet", "0x1111111111111111111111111111111111111111"] },
  { path: ["org", "member", "role"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--principal", "prn_gate1", "--role", "viewer"] },
  { path: ["org", "member", "rm"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--principal", "prn_gate1"] },
  { path: ["org", "invite", "list"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1"] },
  { path: ["org", "invite", "create"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--email", "gate@example.com"] },
  { path: ["org", "invite", "rm"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["org_gate1", "--principal", "prn_gate1"] },

  // ── grants ───────────────────────────────────────────────────────────────
  { path: ["grants", "create"], positionals: [p("wallet")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["0x1111111111111111111111111111111111111111", "--capability", "deploy"] },
  { path: ["grants", "revoke"], positionals: [p("grant_id")], projectScoped: true, legacyPositionalProject: true, minimalArgs: ["grt_gate1"] },

  // ── events / errors (flat, merged runners) ───────────────────────────────
  { path: ["events"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: [], runStyle: "merged" },
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
  { path: ["message", "send"], positionals: [p("words", { variadic: true })], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["hello", "from", "the", "gate"] },
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
  { path: ["billing", "link-wallet"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["00000000-0000-4000-8000-000000000001", "--wallet", "0x1111111111111111111111111111111111111111"] },
  { path: ["billing", "checkout"], positionals: [p("identifier")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["00000000-0000-4000-8000-000000000001", "--product", "email-pack"] },
  { path: ["billing", "auto-recharge"], positionals: [p("org_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["00000000-0000-4000-8000-000000000001", "--state", "on"] },
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
  { path: ["doctor"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--no-scan"], runStyle: "merged" },
  { path: ["notifications", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["notifications", "get"], positionals: [p("notification_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["ntf_gate1"] },
  { path: ["notifications", "preferences"], positionals: [p("set_kv", { required: false, variadic: true })], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["notifications", "test"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["notifications", "channels", "connect"], positionals: [p("channel_type")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["telegram"], skipBehavioral: "polls interactively for the Telegram connect handshake" },
  { path: ["notifications", "channels", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["notifications", "channels", "revoke"], positionals: [p("binding_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["bnd_gate1"] },
  { path: ["notifications", "rules", "add"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["--binding", "bnd_gate1"] },
  { path: ["notifications", "rules", "list"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["notifications", "rules", "rm"], positionals: [p("rule_id")], projectScoped: false, legacyPositionalProject: false, minimalArgs: ["rul_gate1"] },
  { path: ["webhook-secret", "rotate"], positionals: [], projectScoped: false, legacyPositionalProject: false, minimalArgs: [] },
  { path: ["logs"], positionals: [], projectScoped: true, legacyPositionalProject: false, minimalArgs: ["--request-id", "req_gate123"], runStyle: "merged" },
];

// Families deliberately absent from the manifest, consumed by the gate's
// completeness check against cli.mjs's dispatch switch.
export const SKIPPED_FAMILIES = {
  "apply": "pure alias for `deploy apply` (covered by the deploy family)",
  "sender-domain": "removed command — every subcommand errors with COMMAND_REMOVED",
  "dev": "interactive wrapper that spawns `astro dev`",
};
