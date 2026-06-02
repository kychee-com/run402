import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readOperatorSession,
  saveOperatorSession,
  clearOperatorSession,
  isOperatorSessionExpired,
  loadLiveOperatorSession,
  operatorSessionFromTokenResponse,
  getOperatorSessionPath,
  type OperatorSession,
} from "./operator-session.js";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "r402-opsess-"));
  return {
    dir,
    path: join(dir, "operator-session.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function sample(over: Partial<OperatorSession> = {}): OperatorSession {
  return {
    operator_session_token: "ops_abc.def.ghi",
    token_type: "Bearer",
    email: "tal@kychee.com",
    wallets: ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"],
    expires_at: 9_999_999_999_000,
    absolute_expires_at: "2099-01-01T00:00:00.000Z",
    ...over,
  };
}

test("readOperatorSession returns null when the file is absent", () => {
  const { path, cleanup } = tmp();
  try {
    assert.equal(readOperatorSession(path), null);
  } finally {
    cleanup();
  }
});

test("save then read round-trips", () => {
  const { path, cleanup } = tmp();
  try {
    const s = sample();
    saveOperatorSession(s, path);
    assert.deepEqual(readOperatorSession(path), s);
  } finally {
    cleanup();
  }
});

test("save writes mode 0600", { skip: process.platform === "win32" }, () => {
  const { path, cleanup } = tmp();
  try {
    saveOperatorSession(sample(), path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("unparseable JSON reads as null (not logged in)", () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, "{not json", { mode: 0o600 });
    assert.equal(readOperatorSession(path), null);
  } finally {
    cleanup();
  }
});

test("a JSON array (not object) throws a structured error", () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, "[]", { mode: 0o600 });
    assert.throws(() => readOperatorSession(path), /must contain a JSON object/);
  } finally {
    cleanup();
  }
});

test("missing token throws", () => {
  const { path, cleanup } = tmp();
  try {
    const { operator_session_token: _drop, ...rest } = sample();
    writeFileSync(path, JSON.stringify(rest), { mode: 0o600 });
    assert.throws(() => readOperatorSession(path), /operator_session_token/);
  } finally {
    cleanup();
  }
});

test("missing email throws", () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, JSON.stringify(sample({ email: "" })), { mode: 0o600 });
    assert.throws(() => readOperatorSession(path), /'email'/);
  } finally {
    cleanup();
  }
});

test("invalid wallets list throws", () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, JSON.stringify({ ...sample(), wallets: [1, 2] }), { mode: 0o600 });
    assert.throws(() => readOperatorSession(path), /'wallets'/);
  } finally {
    cleanup();
  }
});

test("non-finite expires_at throws", () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, JSON.stringify({ ...sample(), expires_at: "soon" }), { mode: 0o600 });
    assert.throws(() => readOperatorSession(path), /'expires_at'/);
  } finally {
    cleanup();
  }
});

test("clear removes the file and is idempotent", () => {
  const { path, cleanup } = tmp();
  try {
    saveOperatorSession(sample(), path);
    assert.ok(existsSync(path));
    clearOperatorSession(path);
    assert.ok(!existsSync(path));
    // Second clear on an absent file is a no-op (no throw).
    clearOperatorSession(path);
    assert.ok(!existsSync(path));
  } finally {
    cleanup();
  }
});

test("isOperatorSessionExpired: future is live, past is expired", () => {
  const now = 1_000_000_000_000;
  assert.equal(isOperatorSessionExpired(sample({ expires_at: now + 60_000 }), now), false);
  assert.equal(isOperatorSessionExpired(sample({ expires_at: now - 1 }), now), true);
});

test("isOperatorSessionExpired: skew buffer treats near-expiry as expired", () => {
  const now = 1_000_000_000_000;
  // Expires in 5s, but the 10s skew buffer should consider it already expired.
  assert.equal(isOperatorSessionExpired(sample({ expires_at: now + 5_000 }), now), true);
});

test("isOperatorSessionExpired: absolute cap in the past forces expiry", () => {
  const now = 1_000_000_000_000;
  assert.equal(
    isOperatorSessionExpired(
      sample({ expires_at: now + 3_600_000, absolute_expires_at: "1990-01-01T00:00:00.000Z" }),
      now,
    ),
    true,
  );
});

test("loadLiveOperatorSession returns the session when live, null when expired/absent", () => {
  const { path, cleanup } = tmp();
  try {
    const now = 1_000_000_000_000;
    assert.equal(loadLiveOperatorSession(path, now), null); // absent

    saveOperatorSession(sample({ expires_at: now + 600_000 }), path);
    assert.ok(loadLiveOperatorSession(path, now)); // live

    saveOperatorSession(sample({ expires_at: now - 1 }), path);
    assert.equal(loadLiveOperatorSession(path, now), null); // expired
  } finally {
    cleanup();
  }
});

test("operatorSessionFromTokenResponse maps expires_in to an absolute expires_at", () => {
  const now = 1_700_000_000_000;
  const mapped = operatorSessionFromTokenResponse(
    {
      operator_session_token: "ops_xyz",
      token_type: "Bearer",
      expires_in: 1800,
      absolute_expires_at: "2099-01-01T00:00:00.000Z",
      email: "tal@kychee.com",
      wallets: ["0xabc"],
    },
    now,
  );
  assert.equal(mapped.expires_at, now + 1800 * 1000);
  assert.equal(mapped.email, "tal@kychee.com");
  assert.deepEqual(mapped.wallets, ["0xabc"]);
});

test("operatorSessionFromTokenResponse defaults token_type to Bearer and tolerates missing fields", () => {
  const now = 0;
  const mapped = operatorSessionFromTokenResponse({ operator_session_token: "ops_only" }, now);
  assert.equal(mapped.token_type, "Bearer");
  assert.equal(mapped.expires_at, 0);
  assert.deepEqual(mapped.wallets, []);
  assert.equal(mapped.absolute_expires_at, "");
});

test("self-heal tightens a world-readable file to 0600 on read", { skip: process.platform === "win32" }, () => {
  const { path, cleanup } = tmp();
  try {
    writeFileSync(path, JSON.stringify(sample()), { mode: 0o644 });
    chmodSync(path, 0o644); // ensure the loose mode survived umask
    readOperatorSession(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("getOperatorSessionPath honors RUN402_OPERATOR_SESSION_PATH then the base config dir", () => {
  const savedOverride = process.env.RUN402_OPERATOR_SESSION_PATH;
  const savedBase = process.env.RUN402_CONFIG_DIR;
  try {
    process.env.RUN402_OPERATOR_SESSION_PATH = "/custom/op.json";
    assert.equal(getOperatorSessionPath(), "/custom/op.json");

    delete process.env.RUN402_OPERATOR_SESSION_PATH;
    process.env.RUN402_CONFIG_DIR = "/tmp/r402-base";
    // Lives at the BASE dir directly, never under profiles/<name>/.
    assert.equal(getOperatorSessionPath(), join("/tmp/r402-base", "operator-session.json"));
  } finally {
    if (savedOverride === undefined) delete process.env.RUN402_OPERATOR_SESSION_PATH;
    else process.env.RUN402_OPERATOR_SESSION_PATH = savedOverride;
    if (savedBase === undefined) delete process.env.RUN402_CONFIG_DIR;
    else process.env.RUN402_CONFIG_DIR = savedBase;
  }
});

test("operator session path stays at base even when a named wallet is active", () => {
  const savedOverride = process.env.RUN402_OPERATOR_SESSION_PATH;
  const savedBase = process.env.RUN402_CONFIG_DIR;
  const savedWallet = process.env.RUN402_WALLET;
  try {
    delete process.env.RUN402_OPERATOR_SESSION_PATH;
    process.env.RUN402_CONFIG_DIR = "/tmp/r402-base";
    process.env.RUN402_WALLET = "work"; // a named profile must NOT move the session
    assert.equal(getOperatorSessionPath(), join("/tmp/r402-base", "operator-session.json"));
  } finally {
    if (savedOverride === undefined) delete process.env.RUN402_OPERATOR_SESSION_PATH;
    else process.env.RUN402_OPERATOR_SESSION_PATH = savedOverride;
    if (savedBase === undefined) delete process.env.RUN402_CONFIG_DIR;
    else process.env.RUN402_CONFIG_DIR = savedBase;
    if (savedWallet === undefined) delete process.env.RUN402_WALLET;
    else process.env.RUN402_WALLET = savedWallet;
  }
});
