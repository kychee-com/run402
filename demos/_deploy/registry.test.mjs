import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAppConfig, isProvisioned, APP_TIERS } from "./registry.mjs";

const BASE = {
  name: "demo-x",
  subdomain: "demo-x",
  tier: "demo",
  is_system: true,
  gate: null,
  cd: true,
};

test("a well-formed (pre-provisioning) config validates", () => {
  const { ok, errors } = validateAppConfig({ ...BASE }, "demo-x");
  assert.equal(ok, true, errors.join("; "));
});

test("a fully-provisioned config validates", () => {
  const cfg = {
    ...BASE,
    project_id: "prj_1780494471670_0033",
    binding_id: "bnd_32f2646106d138e52f31beb2834422a1",
    owner_wallet: "0x2804a3f59fdd33618b2cb711060550e4ecd6ddc0",
    oidc_subject: "repo:kychee-com/run402:environment:demos",
  };
  const { ok, errors } = validateAppConfig(cfg, "demo-x");
  assert.equal(ok, true, errors.join("; "));
});

test("any secret-bearing key is rejected (no-secret invariant)", () => {
  for (const key of ["service_key", "api_token", "openai_secret", "db_password", "apikey"]) {
    const { ok, errors } = validateAppConfig({ ...BASE, [key]: "x" }, "demo-x");
    assert.equal(ok, false, `expected '${key}' to be rejected`);
    assert.match(errors.join("; "), /forbidden secret-bearing key/);
  }
});

test("name must equal the directory name", () => {
  const { ok, errors } = validateAppConfig({ ...BASE, name: "other" }, "demo-x");
  assert.equal(ok, false);
  assert.match(errors.join("; "), /must equal the directory name/);
});

test("subdomain must be a DNS label", () => {
  for (const bad of ["Bad_Caps", "-leading", "has space", ""]) {
    const { ok } = validateAppConfig({ ...BASE, subdomain: bad }, "demo-x");
    assert.equal(ok, false, `expected subdomain '${bad}' to be rejected`);
  }
});

test("tier must be one of the known tiers", () => {
  assert.equal(validateAppConfig({ ...BASE, tier: "enterprise" }, "demo-x").ok, false);
  assert.deepEqual([...APP_TIERS].sort(), ["demo", "system"]);
});

test("tier 'system' requires is_system: true", () => {
  const { ok, errors } = validateAppConfig({ ...BASE, tier: "system", is_system: false }, "demo-x");
  assert.equal(ok, false);
  assert.match(errors.join("; "), /requires is_system/);
});

test("project_id / binding_id must use their id prefixes when set", () => {
  assert.equal(validateAppConfig({ ...BASE, project_id: "1234" }, "demo-x").ok, false);
  assert.equal(validateAppConfig({ ...BASE, binding_id: "abcd" }, "demo-x").ok, false);
});

test("owner_wallet must be a 0x EVM address when set", () => {
  assert.equal(validateAppConfig({ ...BASE, owner_wallet: "0xnope" }, "demo-x").ok, false);
});

test("isProvisioned tracks a real project_id", () => {
  assert.equal(isProvisioned({}), false);
  assert.equal(isProvisioned({ project_id: "" }), false);
  assert.equal(isProvisioned({ project_id: "<unset>" }), false);
  assert.equal(isProvisioned({ project_id: "prj_1" }), true);
});
