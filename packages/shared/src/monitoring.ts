/**
 * Monitoring & Alerting module — saas-factory F20 standard.
 *
 * Three severity levels, three channels:
 *
 * | Severity | Channels |
 * |----------|----------|
 * | INFO     | Telegram |
 * | WARN     | Telegram + Bugsnag |
 * | CRITICAL | Telegram + Bugsnag + email to barry@kychee.com + tal@kychee.com |
 *
 * The module is intentionally framework-agnostic and uses dependency
 * injection for the actual senders. Concrete senders (Telegram via
 * Bot API, Bugsnag SDK, AWS SES) are wired up in each consuming
 * application — this lets us test the routing logic without making
 * real network calls.
 *
 * Usage:
 *
 *   import { createMonitor } from "@run402/shared/monitoring";
 *   import { telegramSender, bugsnagSender, sesSender } from "./infra";
 *
 *   const monitor = createMonitor({
 *     product: "kysigned",
 *     senders: {
 *       sendTelegram: telegramSender(KYSIGNED_CHAT_ID),
 *       sendBugsnag: bugsnagSender(KYSIGNED_BUGSNAG_KEY),
 *       sendEmail: sesSender(),
 *     },
 *   });
 *
 *   await monitor.notifyCritical("db_outage", { region: "us-east-1" }, error);
 */

export type Severity = "INFO" | "WARN" | "CRITICAL";

export interface MonitoringSenders {
  /** Send a message to the product's Telegram channel. */
  sendTelegram(severity: Severity, event: string, details?: object): Promise<void>;

  /** Send an event to Bugsnag. */
  sendBugsnag(severity: Severity, event: string, error?: Error, details?: object): Promise<void>;

  /** Send an email via SES (or equivalent). */
  sendEmail(to: string[], subject: string, body: string): Promise<void>;
}

export interface MonitoringConfig {
  /** Product name (e.g., "kysigned", "bld402", "run402"). Used in messages and email subjects. */
  product: string;
  /** Concrete sender implementations. */
  senders: MonitoringSenders;
}

/**
 * Hard-coded recipients for CRITICAL alerts.
 * NOT configurable per product — by design.
 * Founders always receive critical alerts.
 */
const CRITICAL_EMAIL_RECIPIENTS = ["barry@kychee.com", "tal@kychee.com"];

export interface Monitor {
  notifyInfo(event: string, details?: object): Promise<void>;
  notifyWarn(event: string, details?: object, error?: Error): Promise<void>;
  notifyCritical(event: string, details?: object, error?: Error): Promise<void>;
}

/**
 * Create a monitor instance scoped to a single product.
 *
 * Each notify method:
 * - Logs to console with severity prefix
 * - Routes to the appropriate channels per severity (see table above)
 * - Catches and isolates per-channel failures so one channel going down
 *   never prevents the others from being used (e.g., if Telegram is down,
 *   the email still goes out for CRITICAL events)
 */
export function createMonitor(config: MonitoringConfig): Monitor {
  const { product, senders } = config;

  // Always include the product name in the details so multi-product
  // dashboards can filter cleanly.
  function withProduct(details?: object): object {
    return { ...(details ?? {}), product };
  }

  // Wrapper that swallows errors so one failing channel doesn't break the others.
  // We log the channel failure to console — if console is also down, we have bigger problems.
  async function safe(channel: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[monitoring] ${channel} send failed:`, err);
    }
  }

  function logToConsole(severity: Severity, event: string, details?: object, error?: Error): void {
    const prefix = `[${severity}] [${product}] ${event}`;
    if (error) {
      // eslint-disable-next-line no-console
      console.error(prefix, details ?? "", error);
    } else if (severity === "CRITICAL" || severity === "WARN") {
      // eslint-disable-next-line no-console
      console.warn(prefix, details ?? "");
    } else {
      // eslint-disable-next-line no-console
      console.log(prefix, details ?? "");
    }
  }

  function buildEmailBody(event: string, details?: object, error?: Error): string {
    const lines: string[] = [
      `Severity: CRITICAL`,
      `Product: ${product}`,
      `Event: ${event}`,
      `Time: ${new Date().toISOString()}`,
      "",
    ];
    if (details) {
      lines.push("Details:");
      for (const [key, value] of Object.entries(details)) {
        lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
      lines.push("");
    }
    if (error) {
      lines.push("Error:");
      lines.push(`  Message: ${error.message}`);
      if (error.stack) {
        lines.push("  Stack:");
        lines.push(error.stack.split("\n").map((l) => `    ${l}`).join("\n"));
      }
      lines.push("");
    }
    lines.push("---");
    lines.push("This is an automated CRITICAL alert from the Kychee monitoring system.");
    lines.push("If you receive this, an incident requires immediate attention.");
    return lines.join("\n");
  }

  return {
    async notifyInfo(event, details) {
      const enriched = withProduct(details);
      logToConsole("INFO", event, enriched);
      await safe("telegram", () => senders.sendTelegram("INFO", event, enriched));
    },

    async notifyWarn(event, details, error) {
      const enriched = withProduct(details);
      logToConsole("WARN", event, enriched, error);
      await Promise.all([
        safe("telegram", () => senders.sendTelegram("WARN", event, enriched)),
        safe("bugsnag", () => senders.sendBugsnag("WARN", event, error, enriched)),
      ]);
    },

    async notifyCritical(event, details, error) {
      const enriched = withProduct(details);
      logToConsole("CRITICAL", event, enriched, error);

      const subject = `[CRITICAL] [${product}] ${event}`;
      const body = buildEmailBody(event, enriched, error);

      await Promise.all([
        safe("telegram", () => senders.sendTelegram("CRITICAL", event, enriched)),
        safe("bugsnag", () => senders.sendBugsnag("CRITICAL", event, error, enriched)),
        safe("email", () => senders.sendEmail(CRITICAL_EMAIL_RECIPIENTS, subject, body)),
      ]);
    },
  };
}

/**
 * Exported for tests and for products that need to verify the
 * hardcoded recipient list (e.g., compliance documentation).
 */
export const CRITICAL_RECIPIENTS = Object.freeze([...CRITICAL_EMAIL_RECIPIENTS]);
