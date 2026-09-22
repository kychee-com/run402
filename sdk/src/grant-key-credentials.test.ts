/**
 * Grant-key credential resolution.
 *
 * The property under test is not "a header is produced" — it is that a
 * grant key is a DETERMINISTIC, EXPLICIT credential class. The node provider's
 * contract says it "selects exactly one credential class and never silently
 * falls back to another after a failure", and a grant key is the class an owner
 * hands an agent deliberately. If presenting one could be silently overridden
 * by an ambient wallet — or if a revoked one quietly downgraded to the
 * owner's own authority — the scoping guarantee would be worthless.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeCredentialsProvider } from "./node/credentials.js";
import {
  GRANT_KEY_CREDENTIALS,
  GRANT_KEY_ENV,
  grantKeyFromEnv,
  isGrantKeyCredentials,
} from "./grant-key-credentials.js";

const TOKEN = "grant-key.test.token.value";

describe("grantKeyFromEnv", () => {
  it("reads and trims the token", () => {
    assert.equal(grantKeyFromEnv({ [GRANT_KEY_ENV]: `  ${TOKEN}  ` }), TOKEN);
  });

  it("treats blank as ABSENT, not as an empty credential", () => {
    // `RUN402_GRANT_KEY=` left in a shell profile must not disable every
    // other credential class — that would be a confusing, silent lockout.
    assert.equal(grantKeyFromEnv({ [GRANT_KEY_ENV]: "" }), undefined);
    assert.equal(grantKeyFromEnv({ [GRANT_KEY_ENV]: "   " }), undefined);
    assert.equal(grantKeyFromEnv({}), undefined);
  });
});

describe("NodeCredentialsProvider — grant-key class", () => {
  it("presents the grant key as a bearer and marks itself so apikeys stand down", async () => {
    const p = new NodeCredentialsProvider({ grantKey: TOKEN });
    assert.equal(isGrantKeyCredentials(p), true, "must be recognised as grant-key-backed");
    assert.equal(Boolean((p as unknown as Record<symbol, unknown>)[GRANT_KEY_CREDENTIALS]), true);
    assert.deepEqual(await p.getAuth("/content/v1/plans"), {
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("wins outright — an explicit grant key is never mixed with or beaten by other classes", async () => {
    // surface:"cli" would otherwise resolve wallet-then-control-plane. Handing
    // over a grant key is deliberate, so it must be the ONLY credential sent.
    const p = new NodeCredentialsProvider({ surface: "cli", grantKey: TOKEN });
    const auth = await p.getAuth("/apply/v1/plans");
    assert.deepEqual(Object.keys(auth ?? {}), ["Authorization"]);
    assert.equal(auth?.Authorization, `Bearer ${TOKEN}`);
  });

  it("an explicit option beats the environment", async () => {
    process.env[GRANT_KEY_ENV] = "from-env-should-lose";
    try {
      const p = new NodeCredentialsProvider({ grantKey: TOKEN });
      assert.equal((await p.getAuth("/content/v1/plans"))?.Authorization, `Bearer ${TOKEN}`);
    } finally {
      delete process.env[GRANT_KEY_ENV];
    }
  });

  it("is NOT grant-key-backed when no token is present", async () => {
    const p = new NodeCredentialsProvider({ authMode: "none" });
    assert.equal(isGrantKeyCredentials(p), false);
    assert.equal(await p.getAuth("/content/v1/plans"), null);
  });

  it("authMode:'grant_key' with no token fails closed rather than falling back", async () => {
    // The whole point of the class is that it does not degrade to ambient
    // authority. Asking for grant-key auth and having none must yield nothing.
    const p = new NodeCredentialsProvider({ authMode: "grant_key" });
    assert.equal(await p.getAuth("/content/v1/plans"), null);
  });
});
