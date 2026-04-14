/**
 * Email body factories for the 90-day KMS-wallet suspension lifecycle.
 *
 * Keeping these as pure functions (no DB/RPC/KMS deps) keeps the templates
 * unit-testable. The scheduler is responsible for fetching balance, ETH/USD
 * price, suspension date, etc. and passing them in here.
 */

export interface WarningEmailInput {
  walletId: string;
  address: string;
  chain: string;
  balanceEth: string;
  balanceUsd: string;
  suspendedAt: Date;
  deletionDate: Date;
  daysLeft: number;
}

export interface FundLossEmailInput {
  walletId: string;
  address: string;
  balanceEth: string;
  balanceUsd: string;
}

export interface EmailBody {
  subject: string;
  html: string;
  text: string;
}

const DOCS_URL = "https://run402.com/docs/kms-contract-wallets";
const SUPPORT_EMAIL = "support@run402.com";

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildWarningEmail(input: WarningEmailInput): EmailBody {
  const { walletId, address, chain, balanceEth, balanceUsd, suspendedAt, deletionDate, daysLeft } =
    input;
  const subject = `URGENT: run402 contract wallet ${walletId} — deletion in ${daysLeft} days`;
  const html = `
<p>Your run402 KMS contract wallet <code>${walletId}</code> (address <code>${address}</code>, chain <code>${chain}</code>) has been suspended since <strong>${iso(suspendedAt)}</strong> and will be permanently deleted on <strong>${iso(deletionDate)}</strong> — in <strong>${daysLeft} days</strong>.</p>
<p>Current on-chain balance: <strong>${balanceEth} ETH</strong> (≈ <strong>$${balanceUsd}</strong>).</p>
<p>run402 is not a custodian. If you take no action, the KMS key that controls this address will be destroyed and the funds will become permanently inaccessible to anyone — including run402.</p>
<p><strong>Your options, in order of reversibility:</strong></p>
<ul>
  <li><strong>Top up</strong> your cash balance to reactivate the wallet and stop the deletion clock.</li>
  <li><strong>Set a recovery address</strong> so that on day 90 we auto-drain the balance to it before deleting the key.</li>
  <li><strong>Drain</strong> the wallet now via <code>POST /contracts/v1/wallets/${walletId}/drain</code>.</li>
</ul>
<p>Docs: <a href="${DOCS_URL}">${DOCS_URL}</a></p>
`.trim();
  const text = [
    `URGENT: run402 contract wallet ${walletId} — deletion in ${daysLeft} days.`,
    ``,
    `Address:        ${address}`,
    `Chain:          ${chain}`,
    `Suspended at:   ${iso(suspendedAt)}`,
    `Deletion date:  ${iso(deletionDate)}`,
    `Balance:        ${balanceEth} ETH (~$${balanceUsd})`,
    ``,
    `run402 is not a custodian. Take action before the deletion date:`,
    `  - top up your cash balance to reactivate the wallet, OR`,
    `  - set a recovery address (auto-drain on day 90), OR`,
    `  - drain the wallet now.`,
    ``,
    `Docs: ${DOCS_URL}`,
  ].join("\n");
  return { subject, html, text };
}

export function buildFundLossEmail(input: FundLossEmailInput): EmailBody {
  const { walletId, address, balanceEth, balanceUsd } = input;
  const subject = `run402 contract wallet ${walletId} deleted — funds permanently lost`;
  const html = `
<p>The KMS key for run402 contract wallet <code>${walletId}</code> (address <code>${address}</code>) has been destroyed after 90 days of suspension.</p>
<p>Balance lost at deletion: <strong>${balanceEth} ETH</strong> (≈ <strong>$${balanceUsd}</strong>).</p>
<p><strong>No recovery address was set</strong>, so the on-chain funds at this address are now permanently inaccessible to anyone — including run402 and AWS. The cryptographic key that controlled this address has been destroyed and cannot be reconstructed.</p>
<p>run402 is not a custodian and has no obligation to compensate for this loss. Warning emails were sent on days 60, 75, and 88 of suspension.</p>
<p>If you have questions, contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
`.trim();
  const text = [
    `run402 contract wallet ${walletId} has been deleted after 90 days of suspension.`,
    ``,
    `Address:       ${address}`,
    `Balance lost:  ${balanceEth} ETH (~$${balanceUsd})`,
    ``,
    `No recovery address was set. The on-chain funds at this address are`,
    `permanently inaccessible to anyone, including run402 and AWS.`,
    ``,
    `Questions: ${SUPPORT_EMAIL}`,
  ].join("\n");
  return { subject, html, text };
}
