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
import {
  planInvocation,
  liveTails,
  renderHelp,
  renderVersion,
  resolveClient,
  RESOLVE_FAIL_MESSAGE,
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

  it("resolution failure is typed, naming the reinstall fix", () => {
    assert.throws(() =>
      resolveClient({
        resolve() {
          throw new Error("Cannot find module 'run402/package.json'");
        },
      }),
    );
    assert.match(RESOLVE_FAIL_MESSAGE, /npm i -g @kychee\/kygit/);
    assert.match(RESOLVE_FAIL_MESSAGE, /npm i -g run402/);
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
