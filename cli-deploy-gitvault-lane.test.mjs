/**
 * `run402 deploy` against a `gitvault_policy: required` project — the lane,
 * and the retirement of the advisory that stood in for it.
 *
 * THE HISTORY, because the gate only makes sense with it. Allocating a vault
 * sets the project's policy to `required`, and until now every commit from a
 * published client was refused 409 `GITVAULT_CLIENT_UPGRADE_REQUIRED`. The
 * envelope's FIRST next_action is `npm i -g run402@latest` — which was TRUE in
 * principle and FALSE in fact, because no published `run402` had a
 * gitvault-capable deploy lane. So the client rewrote the envelope, behind a
 * `GITVAULT_DEPLOY_LANE = "unsupported"` flag, and a CI gate held the flag and
 * the lane in agreement (gitvault dogfood #1, finding C).
 *
 * Change `gitvault-deploy-lane` shipped the lane, so both are retired (design
 * D4): the gateway's envelope is now true as written, and a client that keeps
 * re-authoring it would be lying in the opposite direction — telling an agent
 * that upgrading cannot help when upgrading is exactly what helps.
 *
 * This is the successor gate. It asserts the two things that could silently
 * regress: the rewrite is gone, and the lane is actually wired.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");
const deployV2 = read("./cli/lib/deploy-v2.mjs");
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the interim gitvault advisory is retired, not merely unused", () => {
  it("the flag is gone — a dead flag is a second truth waiting to drift", () => {
    assert.equal(
      /GITVAULT_DEPLOY_LANE/.test(stripComments(deployV2)),
      false,
      "GITVAULT_DEPLOY_LANE must be deleted, not flipped to 'supported'. (The comment recording its retirement is fine; a live symbol is not.)",
    );
  });

  it("the client no longer rewrites GITVAULT_CLIENT_UPGRADE_REQUIRED", () => {
    assert.equal(
      /function\s+enhanceGitvaultDeployError/.test(deployV2),
      false,
      "the advisory rewrite must be deleted; the gateway's envelope is relayed unmodified.",
    );
    assert.equal(
      stripComments(deployV2).includes("GITVAULT_CLIENT_UPGRADE_REQUIRED"),
      false,
      "no code path may special-case the gateway's refusal any more.",
    );
  });
});

describe("the deploy lane speaks gitvault", () => {
  /**
   * The dogfood's own measurement was `grep -c gitvault lib/deploy-v2.mjs` → 0.
   * The check that matters is not the word count but whether the apply path
   * routes through the lane at all: `applyWithGitvault` is what declares the
   * capture at plan time and presents the activation token at commit.
   */
  it("apply routes through applyWithGitvault rather than a bare apply()", () => {
    const code = stripComments(deployV2);
    assert.match(code, /applyWithGitvault\s*\(/, "applyCmd must deploy through the gitvault-aware entry point");
    assert.match(deployV2, /from "#sdk\/node"/);
    assert.equal(
      /_applyEngine\.apply\s*\(/.test(code),
      false,
      "the raw apply engine must not be called directly from applyCmd — that path cannot satisfy a `required` project.",
    );
  });

  it("the CLI stays a thin shim: the lane itself is SDK code (add-gitvault 5.0)", () => {
    const code = stripComments(deployV2);
    // Printing a `capture_id` the SDK handed back is the CLI's job. PRODUCING
    // one — snapshotting, deriving the commitment, exchanging or presenting a
    // token — is the lane's, and any of these appearing here means protocol
    // logic has leaked back into the argument parser.
    for (const protocolWork of ["snapshot_oid_hmac", "activation_token_id", "captureSnapshot", "exchangeActivationToken", "runGitvaultDeploy"]) {
      assert.equal(
        code.includes(protocolWork),
        false,
        `${protocolWork} belongs in the SDK lane, not in the CLI — the CLI parses arguments and prints.`,
      );
    }
  });

  it("prints the gitvault_commit line to stderr, so `| jq` stays clean", () => {
    assert.match(deployV2, /onCommitLine/);
    assert.match(deployV2, /process\.stderr\.write\(`\$\{line\}/);
  });

  it("a non-activating outcome exits non-zero — the five outcomes are a result type, not an error channel", () => {
    const code = stripComments(deployV2);
    assert.match(code, /DEPLOYED_AND_VAULTED/);
    assert.match(code, /DEPLOYED_UNVAULTED_OVERRIDE/);
    assert.match(code, /process\.exit\(1\)/);
  });
});

describe("deploy apply dirty-tree refusal (Observability + dirty-tree-refusal)", () => {
  /**
   * `--allow-dirty` must reach `applyWithGitvault` (which threads it into
   * `gitvault.deploy`'s `snapshot.allowDirty`, same option name captureSnapshot
   * checks) — never re-implemented locally in the CLI, which would risk
   * drifting from the SDK's own `SNAPSHOT_DIRTY_TREE` refusal rule.
   */
  it("--allow-dirty threads to applyWithGitvault's allowDirty option", () => {
    assert.match(deployV2, /["']--allow-dirty["']/);
    assert.match(deployV2, /opts\.allowDirty\s*\?\s*\{\s*allowDirty:\s*true\s*\}/);
  });

  it("dirty-tree disclosure (modified_captured/untracked_captured) is printed to stderr, even under --allow-dirty", () => {
    assert.match(deployV2, /modified_captured/);
    assert.match(deployV2, /untracked_captured/);
  });

  it("every apply result carries the always-on stats block, and -v prints a verbose summary", () => {
    assert.match(deployV2, /stats:\s*sdkStats\(sdk\)/);
    assert.match(deployV2, /printVerboseStats\(opts\.verbose,\s*sdk\)/);
  });
});
