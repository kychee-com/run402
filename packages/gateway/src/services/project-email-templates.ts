/**
 * Project lifecycle email templates.
 *
 * Pure render functions — each takes structured placeholders, returns a
 * `{ subject, html, text }` triple ready to hand to `sendPlatformEmail`.
 * No DB access, no side effects. This module is the single place to tweak
 * copy; `project-lifecycle.ts` just composes placeholders and renders.
 *
 * HTML escaping: project names are user-controlled. Every placeholder that
 * lands in HTML goes through `escapeHtml`. The `subject` and `text` fields
 * are plain strings (no HTML parsing), so they don't need escaping.
 */

const RENEWAL_URL = "https://run402.com";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface PastDueEmailInput {
  projectName: string;
  /** ISO date (YYYY-MM-DD) when the project will transition to `frozen`. */
  frozenOn: string;
}

export interface FrozenEmailInput {
  projectName: string;
  /** ISO date (YYYY-MM-DD) when the project will transition to `dormant` and cron pauses. */
  dormantOn: string;
}

export interface FinalWarningEmailInput {
  projectName: string;
  /** Full ISO timestamp of the exact moment `purgeProject` runs. */
  scheduledPurgeAt: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Fired on entry to `past_due`. Tone: calm, reassuring, "you have time."
 */
export function renderPastDueEmail(input: PastDueEmailInput): RenderedEmail {
  const name = escapeHtml(input.projectName);
  const frozenOn = escapeHtml(input.frozenOn);
  return {
    subject: `Your run402 project "${input.projectName}" is behind on payment`,
    html: `<p>Your run402 project <strong>${name}</strong> has reached the end of its billing lease. Everything is still running — end users are not affected.</p>
<p>If you don't renew your wallet's tier, your control-plane access (deploys, secret rotation, subdomain claims) will be <strong>blocked on ${frozenOn}</strong>. Your site will continue to serve.</p>
<p>You have plenty of time. <a href="${RENEWAL_URL}">Renew at run402.com</a> whenever you're ready.</p>`,
    text: `Your run402 project "${input.projectName}" is behind on payment. Site traffic is unaffected. Control-plane access (deploys, secrets, subdomains) will lock on ${input.frozenOn} if you do not renew. Renew at ${RENEWAL_URL}.`,
  };
}

/**
 * Fired on entry to `frozen`. Tone: firm, explicit about what is blocked and
 * what will happen next. Must name the upcoming cron pause so the owner isn't
 * surprised when nightly digests stop.
 */
export function renderFrozenEmail(input: FrozenEmailInput): RenderedEmail {
  const name = escapeHtml(input.projectName);
  const dormantOn = escapeHtml(input.dormantOn);
  return {
    subject: `run402 project "${input.projectName}" is frozen — deploys disabled`,
    html: `<p>Your run402 project <strong>${name}</strong> is now <strong>frozen</strong>. Deploys, subdomain claims, secret rotation, and other control-plane changes are blocked until you renew.</p>
<p>Your site continues to serve end users as normal. Your subdomain name is reserved for you — no one else can claim it.</p>
<p><strong>On ${dormantOn}, your scheduled (cron) functions will stop running.</strong> Nightly digests, reports, or any other recurring job will silently skip. Shortly after, data deletion will be scheduled.</p>
<p><a href="${RENEWAL_URL}">Renew at run402.com</a> to unfreeze immediately.</p>`,
    text: `run402 project "${input.projectName}" is frozen. Site still serves; control-plane writes (deploys, secrets, subdomains) are blocked. On ${input.dormantOn}, scheduled (cron) functions will stop running. Renew at ${RENEWAL_URL} to unfreeze immediately.`,
  };
}

/**
 * Fired 24 hours before `scheduled_purge_at`. Tone: urgent, irreversible,
 * one last CTA. Not sent if `purge_warning_sent_at` is already stamped.
 */
export function renderFinalWarningEmail(input: FinalWarningEmailInput): RenderedEmail {
  const name = escapeHtml(input.projectName);
  const purgeAt = escapeHtml(input.scheduledPurgeAt);
  return {
    subject: `FINAL NOTICE: run402 project "${input.projectName}" will be permanently deleted tomorrow`,
    html: `<p><strong>This is your final warning.</strong> Your run402 project <strong>${name}</strong> will be permanently deleted on <strong>${purgeAt}</strong> — less than 24 hours from now.</p>
<p>All tenant data, functions, deployments, and secrets will be destroyed. Your subdomain will become claimable by others 14 days after deletion.</p>
<p><strong>This is irreversible.</strong> <a href="${RENEWAL_URL}">Renew at run402.com</a> now to cancel the deletion.</p>`,
    text: `FINAL NOTICE: run402 project "${input.projectName}" will be permanently deleted on ${input.scheduledPurgeAt}. Less than 24 hours left. This is irreversible. Renew at ${RENEWAL_URL} to cancel.`,
  };
}
