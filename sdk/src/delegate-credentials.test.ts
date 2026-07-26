/**
 * Delegate credential resolution.
 *
 * The property under test is not "a header is produced" — it is that a
 * delegate is a DETERMINISTIC, EXPLICIT credential class. The node provider's
 * contract says it "selects exactly one credential class and never silently
 * falls back to another after a failure", and a delegate is the class an owner
 * hands an agent deliberately. If presenting one could be silently overridden
 * by an ambient wallet — or if a revoked one quietly downgraded to the
 * operator's own authority — the scoping guarantee would be worthless.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodeCredentialsProvider } from "./node/credentials.js";
import {
  DELEGATE_CREDENTIALS,
  DELEGATE_TOKEN_ENV,
  delegateTokenFromEnv,
  isDelegateCredentials,
} from "./delegate-credentials.js";

const TOKEN = "delegate.test.token.value";

describe("delegateTokenFromEnv", () => {
  it("reads and trims the token", () => {
    assert.equal(delegateTokenFromEnv({ [DELEGATE_TOKEN_ENV]: `  ${TOKEN}  ` }), TOKEN);
  });

  it("treats blank as ABSENT, not as an empty credential", () => {
    // `RUN402_DELEGATE_TOKEN=` left in a shell profile must not disable every
    // other credential class — that would be a confusing, silent lockout.
    assert.equal(delegateTokenFromEnv({ [DELEGATE_TOKEN_ENV]: "" }), undefined);
    assert.equal(delegateTokenFromEnv({ [DELEGATE_TOKEN_ENV]: "   " }), undefined);
    assert.equal(delegateTokenFromEnv({}), undefined);
  });
});

describe("NodeCredentialsProvider — delegate class", () => {
  it("presents the delegate as a bearer and marks itself so apikeys stand down", async () => {
    const p = new NodeCredentialsProvider({ delegateToken: TOKEN });
    assert.equal(isDelegateCredentials(p), true, "must be recognised as delegate-backed");
    assert.equal(Boolean((p as unknown as Record<symbol, unknown>)[DELEGATE_CREDENTIALS]), true);
    assert.deepEqual(await p.getAuth("/content/v1/plans"), {
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("wins outright — an explicit delegate is never mixed with or beaten by other classes", async () => {
    // surface:"cli" would otherwise resolve wallet-then-control-plane. Handing
    // over a delegate is deliberate, so it must be the ONLY credential sent.
    const p = new NodeCredentialsProvider({ surface: "cli", delegateToken: TOKEN });
    const auth = await p.getAuth("/apply/v1/plans");
    assert.deepEqual(Object.keys(auth ?? {}), ["Authorization"]);
    assert.equal(auth?.Authorization, `Bearer ${TOKEN}`);
  });

  it("an explicit option beats the environment", async () => {
    process.env[DELEGATE_TOKEN_ENV] = "from-env-should-lose";
    try {
      const p = new NodeCredentialsProvider({ delegateToken: TOKEN });
      assert.equal((await p.getAuth("/content/v1/plans"))?.Authorization, `Bearer ${TOKEN}`);
    } finally {
      delete process.env[DELEGATE_TOKEN_ENV];
    }
  });

  it("is NOT delegate-backed when no token is present", async () => {
    const p = new NodeCredentialsProvider({ authMode: "none" });
    assert.equal(isDelegateCredentials(p), false);
    assert.equal(await p.getAuth("/content/v1/plans"), null);
  });

  it("authMode:'delegate' with no token fails closed rather than falling back", async () => {
    // The whole point of the class is that it does not degrade to ambient
    // authority. Asking for delegate auth and having none must yield nothing.
    const p = new NodeCredentialsProvider({ authMode: "delegate" });
    assert.equal(await p.getAuth("/content/v1/plans"), null);
  });
});
