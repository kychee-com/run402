/**
 * Unit tests for the `Run402` constructor entry validation. The constructor
 * must reject malformed options synchronously with a `LocalError`, rather than
 * deferring to a raw `TypeError` at the first auth-needing call.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Run402 } from "./index.js";
import { LocalError, isLocalError } from "./errors.js";
import type { CredentialsProvider } from "./credentials.js";

function makeCreds(
  overrides: Partial<CredentialsProvider> = {},
): CredentialsProvider {
  return {
    async getAuth() {
      return { "SIGN-IN-WITH-X": "test-siwx" };
    },
    async getProject() {
      return null;
    },
    ...overrides,
  };
}

describe("Run402 constructor validation", () => {
  it("throws LocalError when called with no options object", () => {
    assert.throws(
      () => new (Run402 as unknown as { new (): Run402 })(),
      (err: unknown) => isLocalError(err) && /options object/i.test(err.message),
    );
  });

  it("throws LocalError when opts.apiBase is missing", () => {
    assert.throws(
      () => new Run402({} as never),
      (err: unknown) => isLocalError(err) && /apiBase/.test(err.message),
    );
  });

  it("throws LocalError when opts.apiBase is not a string", () => {
    assert.throws(
      () => new Run402({ apiBase: 123 as unknown as string, credentials: makeCreds() }),
      (err: unknown) => isLocalError(err) && /apiBase/.test(err.message),
    );
  });

  it("throws LocalError when opts.credentials is missing", () => {
    assert.throws(
      () =>
        new Run402({ apiBase: "https://api.example.test" } as unknown as {
          apiBase: string;
          credentials: CredentialsProvider;
        }),
      (err: unknown) =>
        isLocalError(err) &&
        /credentials/.test(err.message) &&
        /@run402\/sdk\/node/.test(err.message),
    );
  });

  it("throws LocalError when credentials provider lacks required methods", () => {
    assert.throws(
      () =>
        new Run402({
          apiBase: "https://api.example.test",
          credentials: {} as CredentialsProvider,
        }),
      (err: unknown) =>
        isLocalError(err) && /(getAuth|getProject)/.test(err.message),
    );
  });

  it("throws LocalError when credentials.getAuth is missing", () => {
    assert.throws(
      () =>
        new Run402({
          apiBase: "https://api.example.test",
          credentials: {
            getProject: async () => null,
          } as unknown as CredentialsProvider,
        }),
      (err: unknown) => isLocalError(err) && /getAuth/.test(err.message),
    );
  });

  it("throws LocalError when credentials.getProject is missing", () => {
    assert.throws(
      () =>
        new Run402({
          apiBase: "https://api.example.test",
          credentials: {
            getAuth: async () => ({}),
          } as unknown as CredentialsProvider,
        }),
      (err: unknown) => isLocalError(err) && /getProject/.test(err.message),
    );
  });

  it("constructs successfully with a valid provider", () => {
    const r = new Run402({
      apiBase: "https://api.example.test",
      credentials: makeCreds(),
    });
    assert.ok(r instanceof Run402);
    assert.ok(r.projects);
    assert.ok(r.deploy);
    assert.ok(r.service);
  });

  it("exposes CLI-style SDK aliases for grep-friendly parity (GH-179)", () => {
    const r = new Run402({
      apiBase: "https://api.example.test",
      credentials: makeCreds(),
    }) as any;

    assert.equal(r.image, r.ai);
    for (const path of [
      "contracts.setAlert",
      "contracts.delete",
      "contracts.status",
      "billing.balance",
      "billing.createEmail",
      "billing.autoRecharge",
      "auth.magicLink",
      "auth.verify",
      "auth.setPassword",
      "auth.promoteUser",
      "auth.demoteUser",
      "email.create",
      "email.status",
      "email.info",
      "email.delete",
      "projects.schema",
      "projects.usage",
      "projects.quote",
      "senderDomain.inboundEnable",
      "senderDomain.inboundDisable",
    ]) {
      const value = path.split(".").reduce((obj, key) => obj?.[key], r);
      assert.equal(typeof value, "function", `${path} should be a function`);
    }
  });

  it("LocalError thrown from the constructor carries the constructing-client context", () => {
    try {
      new Run402({} as never);
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(isLocalError(err));
      assert.equal((err as LocalError).context, "constructing client");
    }
  });
});
