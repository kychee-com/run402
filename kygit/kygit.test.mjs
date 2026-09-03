/**
 * kygit shim unit tests (openspec: kygit-cli-shim, kychee-com/run402-private).
 *
 * The shim's contract is mapping mechanics against the surface file — so
 * these tests drive the pure planner with a FIXTURE surface, never a baked
 * copy of the real verb list (the real one is resolved at runtime from the
 * installed run402; parity is by construction, design D1).
 *
 * Run: npm test --workspace=kygit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planInvocation,
  liveTails,
  renderHelp,
  renderVersion,
  resolveClient,
  findRemoteHelper,
  RESOLVE_FAIL_MESSAGE,
  HELPER_MISSING_MESSAGE,
} from "./kygit.mjs";

const SURFACE = {
  surface_version: "9.9.9",
  verbs: [
    "repos create",
    "repos view",
    "repos list",
    "repos mirror",
    "repos access",
    "repos access repair",
    "repos access revoke-key",
  ],
  retired_spellings: [
    { spelling: "gitvault status", successor: "moved to `repos view`" },
    { spelling: "repos push", successor: "renamed to `repos snapshot`" },
  ],
  capabilities: {},
};

describe("planInvocation — mapping", () => {
  it("root-mounts a live verb with its flags", () => {
    assert.deepEqual(planInvocation(SURFACE, ["create", "--name", "x"]), {
      kind: "exec",
      args: ["repos", "create", "--name", "x"],
    });
  });

  it("matches multi-word tails (longest wins)", () => {
    assert.deepEqual(planInvocation(SURFACE, ["access", "repair"]), {
      kind: "exec",
      args: ["repos", "access", "repair"],
    });
    assert.deepEqual(planInvocation(SURFACE, ["access"]), {
      kind: "exec",
      args: ["repos", "access"],
    });
  });

  it("accepts the `repos` prefix as the same thing", () => {
    assert.deepEqual(planInvocation(SURFACE, ["repos", "view"]), {
      kind: "exec",
      args: ["repos", "view"],
    });
  });

  it("maps `login` to the write-capable operator session", () => {
    assert.deepEqual(planInvocation(SURFACE, ["login"]), {
      kind: "exec",
      args: ["operator", "login", "--loopback"],
    });
  });

  it("flags immediately after a verb ride through", () => {
    assert.deepEqual(planInvocation(SURFACE, ["view", "--human"]), {
      kind: "exec",
      args: ["repos", "view", "--human"],
    });
  });
});

describe("planInvocation — refusals", () => {
  it("refuses an out-of-scope verb naming the canonical spelling", () => {
    const plan = planInvocation(SURFACE, ["deploy", "--now"]);
    assert.equal(plan.kind, "refuse");
    assert.match(plan.message, /run402 deploy --now/);
    assert.match(plan.message, /repo family/);
  });

  it("answers a retired spelling with its surface-declared successor", () => {
    const plan = planInvocation(SURFACE, ["gitvault", "status"]);
    assert.equal(plan.kind, "refuse");
    assert.match(plan.message, /moved to `repos view`/);
  });

  it("answers a retired repos tail too", () => {
    const plan = planInvocation(SURFACE, ["push"]);
    assert.equal(plan.kind, "refuse");
    assert.match(plan.message, /renamed to `repos snapshot`/);
  });

  it("never passes an unknown command through", () => {
    const plan = planInvocation(SURFACE, ["teleport"]);
    assert.equal(plan.kind, "refuse");
    assert.match(plan.message, /run402 teleport/);
  });
});

describe("help / version / resolution", () => {
  it("bare kygit and help words render help", () => {
    assert.equal(planInvocation(SURFACE, []).kind, "help");
    assert.equal(planInvocation(SURFACE, ["--help"]).kind, "help");
    assert.equal(planInvocation(SURFACE, ["help"]).kind, "help");
  });

  it("version words render version, naming both packages", () => {
    assert.equal(planInvocation(SURFACE, ["--version"]).kind, "version");
    const line = renderVersion("0.1.0", "9.9.9");
    assert.match(line, /kygit 0\.1\.0/);
    assert.match(line, /run402 9\.9\.9/);
  });

  it("help is derived from the surface and shows the canonical twin", () => {
    const help = renderHelp(SURFACE, "0.1.0", "9.9.9");
    assert.match(help, /kygit <verb> = run402 repos <verb>/);
    assert.match(help, /access revoke-key/);
    assert.match(help, /operator login --loopback/);
  });

  it("liveTails derives only the repos family", () => {
    assert.deepEqual(
      liveTails(SURFACE).map((t) => t.join(" ")),
      ["create", "view", "list", "mirror", "access", "access repair", "access revoke-key"],
    );
  });

  it("resolution failure is typed, naming a fix that actually works", () => {
    assert.throws(() =>
      resolveClient({
        resolve() {
          throw new Error("Cannot find module 'run402/package.json'");
        },
      }),
    );
    assert.match(RESOLVE_FAIL_MESSAGE, /npm i -g run402 @kychee\/kygit/);
    assert.match(RESOLVE_FAIL_MESSAGE, /npm i -g run402/);
    // The advice shown to someone ALREADY stuck must not be the command that
    // put them there: `npm i -g @kychee/kygit` standalone never links
    // git-remote-run402.
    assert.doesNotMatch(RESOLVE_FAIL_MESSAGE, /npm i -g @kychee\/kygit/);
  });

  it("runs main() when invoked through a bin-style SYMLINK (the 0.1.0 regression)", () => {
    // npm installs bins as symlinks; a main-guard that compares the symlink
    // path to import.meta.url makes every installed invocation a silent
    // no-op with exit 0. Invoke through a symlink and demand real output.
    const dir = mkdtempSync(join(tmpdir(), "kygit-symlink-"));
    try {
      const link = join(dir, "kygit");
      symlinkSync(realpathSync(fileURLToPath(new URL("./kygit.mjs", import.meta.url))), link);
      const out = execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" });
      assert.match(out, /^kygit \d+\.\d+\.\d+ \(run402 /);
      let refused = null;
      try {
        execFileSync(process.execPath, [link, "deploy"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        refused = { code: e.status, err: String(e.stderr) };
      }
      assert.ok(refused, "deploy must refuse, not exit 0 silently");
      assert.equal(refused.code, 1);
      assert.match(refused.err, /run402 deploy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the REAL workspace sibling (parity is by construction)", () => {
    const client = resolveClient();
    assert.equal(client.pkg.name, "run402");
    assert.ok(Array.isArray(client.surface.verbs) && client.surface.verbs.length > 0);
    assert.ok(client.cliPath.endsWith("cli.mjs"));
    for (const verb of client.surface.verbs) {
      assert.ok(typeof verb === "string");
    }
  });
});

describe("findRemoteHelper — git's own lookup for the kygit:: helper (design D8)", () => {
  // git spawns `git-remote-kygit` FROM PATH; nothing else finds it. These
  // drive the probe off-platform, so the Windows shape is covered from CI on
  // Linux and from a mac — the transitive-dependency bin-linking gap this
  // helper name closes shows up on Windows. Windows path comparison is
  // case-insensitive (NTFS), which is
  // why a probe for git-remote-kygit.CMD finds npm's lowercase .cmd shim on
  // a real box.
  const winHas = (probe, actual) => probe.toLowerCase() === actual.toLowerCase();

  const posix = (dirs, present) => ({
    env: { PATH: dirs.join(":") },
    platform: "linux",
    exists: (p) => present.includes(p),
  });

  it("finds the helper on a posix PATH", () => {
    assert.equal(
      findRemoteHelper(posix(["/a/bin", "/usr/local/bin"], ["/usr/local/bin/git-remote-kygit"])),
      "/usr/local/bin/git-remote-kygit",
    );
  });

  it("returns null when the helper is nowhere on PATH (a broken/partial install)", () => {
    assert.equal(findRemoteHelper(posix(["/a/bin", "/usr/local/bin"], ["/usr/local/bin/kygit"])), null);
  });

  it("returns null for an empty or missing PATH rather than throwing", () => {
    assert.equal(findRemoteHelper({ env: {}, platform: "linux", exists: () => true }), null);
    assert.equal(findRemoteHelper({ env: { PATH: "" }, platform: "linux", exists: () => true }), null);
  });

  it("resolves the Windows .cmd shim through PATHEXT", () => {
    // npm installs the helper as git-remote-kygit.cmd on Windows; probing the
    // bare name alone would report a false negative on the exact platform
    // the bin-linking gap shows up on.
    const found = findRemoteHelper({
      env: { Path: "C:\\Users\\v\\AppData\\Roaming\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      platform: "win32",
      // NTFS is case-insensitive and PATHEXT is conventionally UPPERCASE while
      // npm writes a lowercase .cmd — so the probe must be allowed to match
      // either, exactly as existsSync would on a real Windows box.
      exists: (p) => winHas(p, "C:\\Users\\v\\AppData\\Roaming\\npm\\git-remote-kygit.cmd"),
    });
    assert.match(found, /git-remote-kygit\.cmd$/i);
  });

  it("splits a Windows PATH on ';' and tolerates quoted entries", () => {
    const found = findRemoteHelper({
      env: { PATH: '"C:\\one";C:\\two', PATHEXT: ".CMD" },
      platform: "win32",
      exists: (p) => winHas(p, "C:\\two\\git-remote-kygit.cmd"),
    });
    assert.match(found, /two/);
  });

  it("the warning names the one command that installs the helper", () => {
    assert.match(HELPER_MISSING_MESSAGE, /git-remote-kygit is not on PATH/);
    assert.match(HELPER_MISSING_MESSAGE, /npm i -g @kychee\/kygit/);
    assert.match(HELPER_MISSING_MESSAGE, /Unable to find remote helper for 'kygit'/);
  });

  it("main warns before exec'ing, so the notice precedes the failing git push", () => {
    // The wiring is one line in main(); main itself is only smoke-tested
    // (it spawns the real CLI), so pin the line rather than leave it uncovered.
    const src = readFileSync(fileURLToPath(new URL("./kygit.mjs", import.meta.url)), "utf8");
    const guard = src.indexOf("HELPER_MISSING_MESSAGE + ");
    const spawnCall = src.indexOf("spawn(process.execPath");
    assert.ok(guard > 0, "main() must emit HELPER_MISSING_MESSAGE");
    assert.ok(guard < spawnCall, "the warning must be written BEFORE the CLI is spawned");
  });

  it("sets RUN402_REMOTE_SCHEME=kygit on the exec'd run402 CLI (design D8 — the door decides the spelling)", () => {
    const src = readFileSync(fileURLToPath(new URL("./kygit.mjs", import.meta.url)), "utf8");
    const spawnCall = src.indexOf("spawn(process.execPath, [client.cliPath");
    const envLine = src.indexOf('RUN402_REMOTE_SCHEME: "kygit"');
    assert.ok(spawnCall > 0);
    assert.ok(envLine > spawnCall, "the env override must be part of the same spawn() call");
  });
});
