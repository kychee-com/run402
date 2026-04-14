import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPoolQuery: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSesCreateIdentity: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSesDeleteIdentity: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSesGetIdentity: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSesDescribeRule: (...args: any[]) => Promise<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSesUpdateRule: (...args: any[]) => Promise<any>;

// Fake client returned by pool.connect() for the advisory-lock path.
// All queries (BEGIN/COMMIT/pg_advisory_xact_lock) resolve with no rows.
const fakeClient = {
  query: async (_s?: unknown, _p?: unknown): Promise<{ rows: unknown[] }> => ({ rows: [] }),
  release: () => {},
};

mock.module("../db/pool.js", {
  namedExports: {
    pool: {
      query: (...args: unknown[]) => mockPoolQuery(...args),
      connect: async () => fakeClient,
    },
  },
});

mock.module("../db/sql.js", {
  namedExports: { sql: (s: string) => s },
});

mock.module("@aws-sdk/client-sesv2", {
  namedExports: {
    SESv2Client: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send(cmd: any) {
        if (cmd._type === "CreateEmailIdentity") return mockSesCreateIdentity(cmd);
        if (cmd._type === "DeleteEmailIdentity") return mockSesDeleteIdentity(cmd);
        if (cmd._type === "GetEmailIdentity") return mockSesGetIdentity(cmd);
        throw new Error(`Unknown command: ${cmd._type}`);
      }
    },
    CreateEmailIdentityCommand: class {
      _type = "CreateEmailIdentity";
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    DeleteEmailIdentityCommand: class {
      _type = "DeleteEmailIdentity";
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    GetEmailIdentityCommand: class {
      _type = "GetEmailIdentity";
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  },
});

mock.module("@aws-sdk/client-ses", {
  namedExports: {
    SESClient: class {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send(cmd: any) {
        if (cmd._type === "DescribeReceiptRule") return mockSesDescribeRule(cmd);
        if (cmd._type === "UpdateReceiptRule") return mockSesUpdateRule(cmd);
        throw new Error(`Unknown SES v1 command: ${cmd._type}`);
      }
    },
    DescribeReceiptRuleCommand: class {
      _type = "DescribeReceiptRule";
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    UpdateReceiptRuleCommand: class {
      _type = "UpdateReceiptRule";
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  },
});

const { registerSenderDomain, getSenderDomainStatus, removeSenderDomain, getVerifiedSenderDomain, enableInbound, disableInbound } = await import("./email-domains.js");

// ---------------------------------------------------------------------------
// registerSenderDomain
// ---------------------------------------------------------------------------
describe("registerSenderDomain", () => {
  beforeEach(() => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    mockSesCreateIdentity = async () => ({
      DkimAttributes: {
        Tokens: ["token1abc", "token2def", "token3ghi"],
        SigningEnabled: true,
        Status: "PENDING",
      },
    });
  });

  it("rejects blocklisted domain (run402.com)", async () => {
    const result = await registerSenderDomain("proj1", "0xwallet1", "run402.com");
    assert.equal(result.error, true);
    assert.ok(result.message!.includes("blocklist") || result.message!.includes("not allowed"));
  });

  it("rejects blocklisted domain (gmail.com)", async () => {
    const result = await registerSenderDomain("proj1", "0xwallet1", "gmail.com");
    assert.equal(result.error, true);
  });

  it("rejects invalid domain format", async () => {
    const result = await registerSenderDomain("proj1", "0xwallet1", "not a domain");
    assert.equal(result.error, true);
  });

  it("rejects empty domain", async () => {
    const result = await registerSenderDomain("proj1", "0xwallet1", "");
    assert.equal(result.error, true);
  });

  it("rejects if project already has a domain", async () => {
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("email_domains") && sql.includes("project_id")) {
        return { rows: [{ domain: "existing.com", status: "verified" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const result = await registerSenderDomain("proj1", "0xwallet1", "newdomain.com");
    assert.equal(result.error, true);
    assert.ok(result.message!.includes("already has"));
  });

  it("rejects if domain registered by different wallet", async () => {
    mockPoolQuery = async (sql: string) => {
      // No domain for this project
      if (sql.includes("SELECT") && sql.includes("project_id = $1")) {
        return { rows: [], rowCount: 0 };
      }
      // Domain exists for different wallet
      if (sql.includes("SELECT") && sql.includes("domain = $1")) {
        return { rows: [{ wallet_address: "0xother_wallet", status: "verified" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const result = await registerSenderDomain("proj1", "0xwallet1", "taken.com");
    assert.equal(result.error, true);
    assert.ok(result.message!.includes("different") || result.message!.includes("another"));
  });

  it("allows domain already verified by same wallet (instant verified)", async () => {
    mockPoolQuery = async (sql: string) => {
      // No domain for this project
      if (sql.includes("SELECT") && sql.includes("project_id = $1")) {
        return { rows: [], rowCount: 0 };
      }
      // Domain exists, verified, same wallet
      if (sql.includes("SELECT") && sql.includes("domain = $1")) {
        return { rows: [{ wallet_address: "0xwallet1", status: "verified", dkim_records: [{ type: "CNAME", name: "a", value: "b" }] }], rowCount: 1 };
      }
      // INSERT
      if (sql.includes("INSERT")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const result = await registerSenderDomain("proj1", "0xwallet1", "myshared.com");
    assert.equal(result.error, undefined);
    assert.equal(result.status, "verified");
  });

  it("calls SES CreateEmailIdentity for new domain and returns DKIM records", async () => {
    let sesCalledWith: unknown = null;
    mockSesCreateIdentity = async (cmd: { input: unknown }) => {
      sesCalledWith = cmd.input;
      return {
        DkimAttributes: {
          Tokens: ["tok1", "tok2", "tok3"],
          Status: "PENDING",
        },
      };
    };
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };

    const result = await registerSenderDomain("proj1", "0xwallet1", "mybrand.com");
    assert.equal(result.error, undefined);
    assert.equal(result.status, "pending");
    assert.ok(sesCalledWith);
    assert.ok(result.dns_records);
    assert.equal(result.dns_records.length, 5); // 3 DKIM CNAMEs + SPF TXT + DMARC TXT
    // Verify DKIM CNAME format
    const dkimRecords = result.dns_records.filter((r: { type: string }) => r.type === "CNAME");
    assert.equal(dkimRecords.length, 3);
  });

  it("stores domain with status=pending in DB", async () => {
    const inserts: string[] = [];
    mockPoolQuery = async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT")) {
        inserts.push(sql);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    await registerSenderDomain("proj1", "0xwallet1", "newbrand.com");
    assert.ok(inserts.length > 0, "should INSERT into email_domains");
    assert.ok(inserts[0].includes("email_domains"));
  });
});

// ---------------------------------------------------------------------------
// getSenderDomainStatus
// ---------------------------------------------------------------------------
describe("getSenderDomainStatus", () => {
  it("returns null if no domain registered", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    const result = await getSenderDomainStatus("proj1");
    assert.equal(result, null);
  });

  it("returns domain without SES poll when already verified", async () => {
    let sesCalled = false;
    mockSesGetIdentity = async () => { sesCalled = true; return {}; };
    mockPoolQuery = async () => ({
      rows: [{ domain: "mybrand.com", status: "verified", dkim_records: [], verified_at: new Date() }],
      rowCount: 1,
    });
    const result = await getSenderDomainStatus("proj1");
    assert.ok(result);
    assert.equal(result.status, "verified");
    assert.equal(sesCalled, false, "should NOT poll SES for verified domains");
  });

  it("polls SES and updates to verified when DKIM SUCCESS", async () => {
    mockSesGetIdentity = async () => ({
      DkimAttributes: { Status: "SUCCESS" },
    });
    let updatedStatus: string | null = null;
    mockPoolQuery = async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT")) {
        return { rows: [{ domain: "mybrand.com", status: "pending", dkim_records: [], verified_at: null }], rowCount: 1 };
      }
      if (sql.includes("UPDATE") && params) {
        updatedStatus = params[0] as string;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const result = await getSenderDomainStatus("proj1");
    assert.ok(result);
    assert.equal(result.status, "verified");
    assert.equal(updatedStatus, "verified");
  });

  it("returns pending when SES reports PENDING", async () => {
    mockSesGetIdentity = async () => ({
      DkimAttributes: { Status: "PENDING" },
    });
    mockPoolQuery = async () => ({
      rows: [{ domain: "mybrand.com", status: "pending", dkim_records: [], verified_at: null }],
      rowCount: 1,
    });
    const result = await getSenderDomainStatus("proj1");
    assert.ok(result);
    assert.equal(result.status, "pending");
  });

  it("includes inbound object with mx_record and disabled by default", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        domain: "mybrand.com", status: "verified", dkim_records: [],
        verified_at: new Date(), inbound_enabled: false,
      }],
      rowCount: 1,
    });
    const result = await getSenderDomainStatus("proj1");
    assert.ok(result);
    assert.ok(result.inbound, "response must include inbound object");
    assert.equal(result.inbound.enabled, false);
    assert.equal(result.inbound.mx_record, "10 inbound-smtp.us-east-1.amazonaws.com");
    // mx_verified is only meaningful when enabled; should be false when disabled.
    assert.equal(result.inbound.mx_verified, false);
  });

  it("includes inbound.enabled=true when inbound_enabled column is set", async () => {
    mockPoolQuery = async () => ({
      rows: [{
        domain: "mybrand.com", status: "verified", dkim_records: [],
        verified_at: new Date(), inbound_enabled: true,
      }],
      rowCount: 1,
    });
    const result = await getSenderDomainStatus("proj1");
    assert.ok(result);
    assert.equal(result.inbound.enabled, true);
    // mx_verified depends on real DNS; just assert it's a boolean.
    assert.equal(typeof result.inbound.mx_verified, "boolean");
  });
});

// ---------------------------------------------------------------------------
// removeSenderDomain
// ---------------------------------------------------------------------------
describe("removeSenderDomain", () => {
  it("returns false if no domain exists", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    const result = await removeSenderDomain("proj1");
    assert.equal(result, false);
  });

  it("removes DB row", async () => {
    let deleteCalled = false;
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("project_id = $1")) {
        return { rows: [{ domain: "mybrand.com", project_id: "proj1" }], rowCount: 1 };
      }
      if (sql.includes("DELETE")) { deleteCalled = true; return { rows: [], rowCount: 1 }; }
      // Check if other projects use this domain — none
      if (sql.includes("SELECT") && sql.includes("domain = $1")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    mockSesDeleteIdentity = async () => ({});
    const result = await removeSenderDomain("proj1");
    assert.equal(result, true);
    assert.ok(deleteCalled);
  });

  it("calls SES DeleteEmailIdentity only when last project using domain", async () => {
    let sesDeleteCalled = false;
    mockSesDeleteIdentity = async () => { sesDeleteCalled = true; return {}; };
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("project_id = $1")) {
        return { rows: [{ domain: "mybrand.com", project_id: "proj1" }], rowCount: 1 };
      }
      if (sql.includes("DELETE")) return { rows: [], rowCount: 1 };
      // No other projects use this domain
      if (sql.includes("SELECT") && sql.includes("domain = $1")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    };
    await removeSenderDomain("proj1");
    assert.ok(sesDeleteCalled, "should call SES DeleteEmailIdentity");
  });

  it("does NOT call SES DeleteEmailIdentity when other projects still use domain", async () => {
    let sesDeleteCalled = false;
    mockSesDeleteIdentity = async () => { sesDeleteCalled = true; return {}; };
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT") && sql.includes("project_id = $1")) {
        return { rows: [{ domain: "shared.com", project_id: "proj1" }], rowCount: 1 };
      }
      if (sql.includes("DELETE")) return { rows: [], rowCount: 1 };
      // Other projects still use this domain
      if (sql.includes("SELECT") && sql.includes("domain = $1")) {
        return { rows: [{ project_id: "proj2" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    await removeSenderDomain("proj1");
    assert.equal(sesDeleteCalled, false, "should NOT call SES DeleteEmailIdentity");
  });
});

// ---------------------------------------------------------------------------
// getVerifiedSenderDomain
// ---------------------------------------------------------------------------
describe("getVerifiedSenderDomain", () => {
  it("returns domain when verified", async () => {
    mockPoolQuery = async () => ({
      rows: [{ domain: "mybrand.com", status: "verified" }],
      rowCount: 1,
    });
    const result = await getVerifiedSenderDomain("proj_vsd_1");
    assert.equal(result, "mybrand.com");
  });

  it("returns null when pending", async () => {
    mockPoolQuery = async () => ({
      rows: [{ domain: "mybrand.com", status: "pending" }],
      rowCount: 1,
    });
    const result = await getVerifiedSenderDomain("proj_vsd_2");
    assert.equal(result, null);
  });

  it("returns null when no domain", async () => {
    mockPoolQuery = async () => ({ rows: [], rowCount: 0 });
    const result = await getVerifiedSenderDomain("proj_vsd_3");
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// enableInbound
// ---------------------------------------------------------------------------
describe("enableInbound", () => {
  beforeEach(() => {
    mockSesDescribeRule = async () => ({
      Rule: { Recipients: ["mail.run402.com"], Actions: [] },
    });
    mockSesUpdateRule = async () => ({});
  });

  it("enables inbound on a verified domain", async () => {
    let updatedInbound = false;
    let sesUpdateInput: unknown = null;
    mockPoolQuery = async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT") && sql.includes("email_domains")) {
        return { rows: [{ domain: "kysigned.com", status: "verified", inbound_enabled: false }] };
      }
      if (sql.includes("UPDATE") && sql.includes("inbound_enabled")) {
        updatedInbound = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    mockSesUpdateRule = async (cmd: { input: unknown }) => {
      sesUpdateInput = cmd.input;
      return {};
    };
    const result = await enableInbound("proj1", "kysigned.com");
    assert.equal(result.error, undefined);
    assert.equal(result.status, "enabled");
    assert.ok(updatedInbound);
    assert.ok(sesUpdateInput);
  });

  it("rejects when domain is not verified", async () => {
    mockPoolQuery = async () => ({
      rows: [{ domain: "kysigned.com", status: "pending", inbound_enabled: false }],
    });
    const result = await enableInbound("proj1", "kysigned.com");
    assert.equal(result.error, true);
    assert.ok(result.message!.includes("verified"));
  });

  it("rejects when domain not found", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    const result = await enableInbound("proj1", "nonexistent.com");
    assert.equal(result.error, true);
  });

  it("is idempotent when already enabled", async () => {
    mockPoolQuery = async () => ({
      rows: [{ domain: "kysigned.com", status: "verified", inbound_enabled: true }],
    });
    const result = await enableInbound("proj1", "kysigned.com");
    assert.equal(result.error, undefined);
    assert.equal(result.status, "enabled");
  });

  it("adds domain to SES receipt rule recipients list", async () => {
    let updatedRecipients: string[] = [];
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT")) {
        return { rows: [{ domain: "kysigned.com", status: "verified", inbound_enabled: false }] };
      }
      if (sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    mockSesDescribeRule = async () => ({
      Rule: { Recipients: ["mail.run402.com"], Actions: [{ S3Action: {} }, { LambdaAction: {} }] },
    });
    mockSesUpdateRule = async (cmd: { input: { Rule: { Recipients: string[] } } }) => {
      updatedRecipients = cmd.input.Rule.Recipients;
      return {};
    };
    await enableInbound("proj1", "kysigned.com");
    assert.ok(updatedRecipients.includes("kysigned.com"));
    assert.ok(updatedRecipients.includes("mail.run402.com"));
  });
});

// ---------------------------------------------------------------------------
// disableInbound
// ---------------------------------------------------------------------------
describe("disableInbound", () => {
  beforeEach(() => {
    mockSesDescribeRule = async () => ({
      Rule: { Recipients: ["mail.run402.com", "kysigned.com"], Actions: [] },
    });
    mockSesUpdateRule = async () => ({});
  });

  it("disables inbound on a domain", async () => {
    let updatedInbound = false;
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT")) {
        return { rows: [{ domain: "kysigned.com", status: "verified", inbound_enabled: true }] };
      }
      if (sql.includes("UPDATE") && sql.includes("inbound_enabled")) {
        updatedInbound = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const result = await disableInbound("proj1", "kysigned.com");
    assert.equal(result.error, undefined);
    assert.equal(result.status, "disabled");
    assert.ok(updatedInbound);
  });

  it("removes domain from SES receipt rule recipients list", async () => {
    let updatedRecipients: string[] = [];
    mockPoolQuery = async (sql: string) => {
      if (sql.includes("SELECT")) {
        return { rows: [{ domain: "kysigned.com", status: "verified", inbound_enabled: true }] };
      }
      if (sql.includes("UPDATE")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    mockSesUpdateRule = async (cmd: { input: { Rule: { Recipients: string[] } } }) => {
      updatedRecipients = cmd.input.Rule.Recipients;
      return {};
    };
    await disableInbound("proj1", "kysigned.com");
    assert.ok(!updatedRecipients.includes("kysigned.com"));
    assert.ok(updatedRecipients.includes("mail.run402.com"));
  });

  it("returns not found when domain does not exist", async () => {
    mockPoolQuery = async () => ({ rows: [] });
    const result = await disableInbound("proj1", "nonexistent.com");
    assert.equal(result.error, true);
  });

  it("is idempotent when already disabled", async () => {
    mockPoolQuery = async () => ({
      rows: [{ domain: "kysigned.com", status: "verified", inbound_enabled: false }],
    });
    const result = await disableInbound("proj1", "kysigned.com");
    assert.equal(result.error, undefined);
    assert.equal(result.status, "disabled");
  });
});
