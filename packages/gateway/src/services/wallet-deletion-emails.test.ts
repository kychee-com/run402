import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWarningEmail,
  buildFundLossEmail,
} from "./wallet-deletion-emails.js";

const SUSPENDED_AT = new Date("2026-01-01T00:00:00Z");

test("warning email subject includes days-left and wallet id", () => {
  const e = buildWarningEmail({
    walletId: "cwal_abc123",
    address: "0xdead",
    chain: "base-mainnet",
    balanceEth: "0.012300",
    balanceUsd: "41.05",
    suspendedAt: SUSPENDED_AT,
    deletionDate: new Date("2026-04-01T00:00:00Z"),
    daysLeft: 30,
  });
  assert.match(e.subject, /30 days/);
  assert.match(e.subject, /cwal_abc123/);
});

test("warning email body includes balance, suspension + deletion dates, wallet address, docs link, recovery options", () => {
  const e = buildWarningEmail({
    walletId: "cwal_abc123",
    address: "0xDEADBEEF00000000000000000000000000000001",
    chain: "base-mainnet",
    balanceEth: "0.012300",
    balanceUsd: "41.05",
    suspendedAt: SUSPENDED_AT,
    deletionDate: new Date("2026-04-01T00:00:00Z"),
    daysLeft: 30,
  });
  // Address visible in both html + text
  assert.match(e.html, /0xDEADBEEF00000000000000000000000000000001/);
  assert.match(e.text, /0xDEADBEEF00000000000000000000000000000001/);
  // Balance
  assert.match(e.html, /0\.012300 ETH/);
  assert.match(e.html, /\$41\.05/);
  // Dates
  assert.match(e.html, /2026-01-01/);
  assert.match(e.html, /2026-04-01/);
  // Recovery options + docs link
  assert.match(e.html, /recovery address/i);
  assert.match(e.html, /drain/i);
  assert.match(e.html, /top up/i);
  assert.match(e.html, /run402\.com\/docs/);
});

test("fund-loss email names the wallet, the lost balance, and says no recovery address was set", () => {
  const e = buildFundLossEmail({
    walletId: "cwal_abc123",
    address: "0xDEADBEEF00000000000000000000000000000001",
    balanceEth: "0.050000",
    balanceUsd: "167.20",
  });
  assert.match(e.subject, /cwal_abc123/);
  assert.match(e.html, /0\.050000 ETH/);
  assert.match(e.html, /\$167\.20/);
  assert.match(e.html, /no recovery address/i);
  assert.match(e.html, /permanently inaccessible/i);
  assert.match(e.html, /support@run402\.com|run402\.com\/support|mailto:support/);
});

test("fund-loss email text version mirrors the html body", () => {
  const e = buildFundLossEmail({
    walletId: "cwal_abc123",
    address: "0xDEADBEEF00000000000000000000000000000001",
    balanceEth: "0.050000",
    balanceUsd: "167.20",
  });
  assert.match(e.text, /cwal_abc123/);
  assert.match(e.text, /0\.050000 ETH/);
  assert.match(e.text, /no recovery address/i);
});
