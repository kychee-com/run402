/**
 * `run402 deploy` against a `gitvault_policy: required` project — say what
 * actually works.
 *
 * THE DEFECT (gitvault dogfood #1, finding C). Allocating a vault sets the
 * project's policy to `required`, and from then on every commit from a
 * pre-gitvault client is refused 409 `GITVAULT_CLIENT_UPGRADE_REQUIRED`. The
 * envelope's FIRST next_action is `npm i -g run402@latest` — and the published
 * `run402` deploy lane declares no capture and sends no gitvault block, so
 * upgrading resolves nothing. An agent following the envelope loops on an
 * upgrade that cannot help while its project stays undeployable.
 *
 * The deploy-lane wiring itself is a design change, not a wiring one (see the
 * `GITVAULT_DEPLOY_LANE` doc comment: a faithful implementation builds from an
 * isolated materialization of the snapshot commit, and build output is
 * normally gitignored, so it is not in the snapshot). Until it lands, the
 * client must not relay a promise it cannot keep.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GITVAULT_DEPLOY_LANE, enhanceGitvaultDeployError } from "./cli/lib/deploy-v2.mjs";

/** The envelope the gateway actually sends (activation-gate.ts). */
function gatewayRefusal() {
  const err = new Error("This project requires source capture (gitvault_policy: required) and the client did not speak the gitvault protocol.");
  err.body = {
    code: "GITVAULT_CLIENT_UPGRADE_REQUIRED",
    message: err.message,
    details: { gitvault_policy: "required", outcome: "DEPLOY_BLOCKED_PUSH_FAILED" },
    next_actions: [
      { type: "upgrade_client", command: "npm i -g run402@latest", why: "A gitvault-capable run402 CLI declares the capture at plan time, pushes, and commits with the activation token automatically." },
      { type: "grandfather_policy", command: "run402 gitvault policy grandfathered --reason <why>", why: "An owner may set gitvault_policy: grandfathered.", requires_approval: true, safe_to_auto_execute: false },
    ],
  };
  return err;
}

describe("GITVAULT_CLIENT_UPGRADE_REQUIRED — the client's own guidance", () => {
  it("does not lead with an upgrade that cannot fix the refusal", () => {
    const enhanced = enhanceGitvaultDeployError(gatewayRefusal());
    const first = enhanced.body.next_actions[0];
    assert.notEqual(first.type, "upgrade_client", "the unhelpful action must not be the one an agent executes first");
    assert.match(first.command, /run402 gitvault policy grandfathered/);
  });

  it("keeps the gateway's own actions rather than dropping them, with the upgrade's promise corrected", () => {
    const enhanced = enhanceGitvaultDeployError(gatewayRefusal());
    const upgrade = enhanced.body.next_actions.find((a) => a.type === "upgrade_client");
    assert.ok(upgrade, "the gateway's upgrade_client action must survive, not be censored");
    assert.equal(upgrade.command, "npm i -g run402@latest");
    assert.match(upgrade.why, /does not resolve the refusal today/);
    const grandfather = enhanced.body.next_actions.find((a) => a.type === "grandfather_policy");
    assert.ok(grandfather, "the gateway's grandfather_policy action must survive");
    assert.equal(grandfather.requires_approval, true, "the approval flag must not be laundered away");
  });

  it("names the capture lane, which DOES work today and is not gated on a deploy", () => {
    const enhanced = enhanceGitvaultDeployError(gatewayRefusal());
    assert.match(enhanced.body.hint, /gitvault push/);
    assert.match(enhanced.body.hint, /git push run402/);
    assert.match(enhanced.body.hint, /not gated on a deploy/);
    assert.ok(
      enhanced.body.next_actions.some((a) => a.command === "run402 gitvault push"),
      "an agent must be handed the command that vaults its source regardless",
    );
  });

  it("offers the way back to `required` so grandfathering is not a one-way door", () => {
    const enhanced = enhanceGitvaultDeployError(gatewayRefusal());
    assert.ok(enhanced.body.next_actions.some((a) => a.command === "run402 gitvault policy required"));
  });

  it("leaves every other deploy error untouched", () => {
    const other = new Error("nope");
    other.body = { code: "MISSING_REQUIRED_SECRET", next_actions: [{ type: "edit_request" }] };
    assert.equal(enhanceGitvaultDeployError(other), other);
  });

  it("survives an envelope with no next_actions at all", () => {
    const bare = new Error("refused");
    bare.body = { code: "GITVAULT_CLIENT_UPGRADE_REQUIRED" };
    const enhanced = enhanceGitvaultDeployError(bare);
    assert.ok(enhanced.body.next_actions.length >= 3);
  });
});

describe("the advisory and the deploy lane cannot silently disagree", () => {
  const deployV2 = readFileSync(fileURLToPath(new URL("./cli/lib/deploy-v2.mjs", import.meta.url)), "utf-8");
  const deploy = readFileSync(fileURLToPath(new URL("./cli/lib/deploy.mjs", import.meta.url)), "utf-8");

  it("the flag still says what the code does", () => {
    // The dogfood's own measurement: `grep -c gitvault lib/deploy-v2.mjs
    // lib/deploy.mjs` → 0, 0. It is no longer 0 (this advisory mentions
    // gitvault), so the check is the one that matters: does the lane send a
    // gitvault block on the wire?
    const laneSpeaksGitvault =
      /gitvault\s*:/.test(deployV2.replace(/^\s*\/\/.*$/gm, "")) ||
      /gitvault/.test(deploy);
    if (GITVAULT_DEPLOY_LANE === "unsupported") {
      assert.equal(
        laneSpeaksGitvault,
        false,
        "the deploy lane appears to send a gitvault block, but GITVAULT_DEPLOY_LANE still says 'unsupported' — " +
        "flip the flag (and delete the advisory rewrite) in the same change that wires the lane.",
      );
    } else {
      assert.equal(
        laneSpeaksGitvault,
        true,
        "GITVAULT_DEPLOY_LANE says 'supported' but the deploy lane sends no gitvault block.",
      );
    }
  });

  it("the flag's retirement condition is written down where the next person will look", () => {
    assert.match(deployV2, /RETIREMENT CONDITION/);
    assert.match(deployV2, /isolated materialization/);
  });
});
