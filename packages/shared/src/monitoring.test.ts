/**
 * Monitoring module tests — from saas-factory F20 spec.
 *
 * The module exposes notifyInfo, notifyWarn, notifyCritical with consistent API.
 * - notifyInfo: console + Telegram only
 * - notifyWarn: console + Telegram + Bugsnag
 * - notifyCritical: console + Telegram + Bugsnag + email to barry/tal@kychee.com
 *
 * Tests use injected senders so we can verify routing without actually
 * calling Telegram, Bugsnag, or SES.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor, type MonitoringSenders } from './monitoring.js';

function createMockSenders(): MonitoringSenders & {
  telegramCalls: Array<{ severity: string; event: string; details?: object }>;
  bugsnagCalls: Array<{ severity: string; event: string; error?: Error; details?: object }>;
  emailCalls: Array<{ to: string[]; subject: string; body: string }>;
} {
  const telegramCalls: Array<{ severity: string; event: string; details?: object }> = [];
  const bugsnagCalls: Array<{ severity: string; event: string; error?: Error; details?: object }> = [];
  const emailCalls: Array<{ to: string[]; subject: string; body: string }> = [];

  return {
    telegramCalls,
    bugsnagCalls,
    emailCalls,
    sendTelegram: async (severity, event, details) => {
      telegramCalls.push({ severity, event, details });
    },
    sendBugsnag: async (severity, event, error, details) => {
      bugsnagCalls.push({ severity, event, error, details });
    },
    sendEmail: async (to, subject, body) => {
      emailCalls.push({ to, subject, body });
    },
  };
}

describe('Monitoring — saas-factory F20', () => {
  let senders: ReturnType<typeof createMockSenders>;
  let monitor: ReturnType<typeof createMonitor>;

  beforeEach(() => {
    senders = createMockSenders();
    monitor = createMonitor({ product: 'kysigned', senders });
  });

  describe('notifyInfo', () => {
    it('should send to Telegram only', async () => {
      await monitor.notifyInfo('user_signup', { email: 'test@example.com' });
      assert.equal(senders.telegramCalls.length, 1);
      assert.equal(senders.bugsnagCalls.length, 0);
      assert.equal(senders.emailCalls.length, 0);
    });

    it('should pass severity, event, and details to Telegram (with product enrichment)', async () => {
      await monitor.notifyInfo('envelope_created', { id: 'env-1' });
      assert.equal(senders.telegramCalls[0].severity, 'INFO');
      assert.equal(senders.telegramCalls[0].event, 'envelope_created');
      // Details are enriched with the product name automatically
      assert.deepEqual(senders.telegramCalls[0].details, { id: 'env-1', product: 'kysigned' });
    });
  });

  describe('notifyWarn', () => {
    it('should send to Telegram AND Bugsnag', async () => {
      await monitor.notifyWarn('email_bounce', { recipient: 'bad@example.com' });
      assert.equal(senders.telegramCalls.length, 1);
      assert.equal(senders.bugsnagCalls.length, 1);
      assert.equal(senders.emailCalls.length, 0);
    });

    it('should mark severity as WARN', async () => {
      await monitor.notifyWarn('email_bounce');
      assert.equal(senders.telegramCalls[0].severity, 'WARN');
      assert.equal(senders.bugsnagCalls[0].severity, 'WARN');
    });

    it('should pass error to Bugsnag', async () => {
      const err = new Error('SMTP rejected');
      await monitor.notifyWarn('email_bounce', { recipient: 'bad@x.com' }, err);
      assert.equal(senders.bugsnagCalls[0].error, err);
    });
  });

  describe('notifyCritical', () => {
    it('should send to Telegram AND Bugsnag AND email', async () => {
      await monitor.notifyCritical('db_connection_failure', { host: 'aurora-1' });
      assert.equal(senders.telegramCalls.length, 1);
      assert.equal(senders.bugsnagCalls.length, 1);
      assert.equal(senders.emailCalls.length, 1);
    });

    it('should mark severity as CRITICAL in all channels', async () => {
      await monitor.notifyCritical('breach_indicator');
      assert.equal(senders.telegramCalls[0].severity, 'CRITICAL');
      assert.equal(senders.bugsnagCalls[0].severity, 'CRITICAL');
    });

    it('should email barry@kychee.com and tal@kychee.com (hardcoded)', async () => {
      await monitor.notifyCritical('breach_indicator');
      const recipients = senders.emailCalls[0].to;
      assert.ok(recipients.includes('barry@kychee.com'));
      assert.ok(recipients.includes('tal@kychee.com'));
    });

    it('email subject should include product name and event', async () => {
      await monitor.notifyCritical('breach_indicator');
      const subject = senders.emailCalls[0].subject;
      assert.ok(subject.includes('kysigned'));
      assert.ok(subject.includes('breach_indicator'));
      assert.ok(subject.includes('CRITICAL'));
    });

    it('email body should include event details and error if provided', async () => {
      const err = new Error('Aurora cluster unreachable');
      await monitor.notifyCritical('db_outage', { region: 'us-east-1' }, err);
      const body = senders.emailCalls[0].body;
      assert.ok(body.includes('db_outage'));
      assert.ok(body.includes('us-east-1'));
      assert.ok(body.includes('Aurora cluster unreachable'));
    });
  });

  describe('product context', () => {
    it('should tag all telegram messages with the product name', async () => {
      const monitor2 = createMonitor({ product: 'bld402', senders });
      await monitor2.notifyInfo('test_event');
      const details = senders.telegramCalls[0].details as { product?: string } | undefined;
      assert.equal(details?.product, 'bld402');
    });
  });

  describe('failure isolation', () => {
    it('should not throw if Telegram sender throws', async () => {
      const failingSenders: MonitoringSenders = {
        sendTelegram: async () => { throw new Error('Telegram down'); },
        sendBugsnag: async () => {},
        sendEmail: async () => {},
      };
      const m = createMonitor({ product: 'kysigned', senders: failingSenders });
      await assert.doesNotReject(() => m.notifyCritical('test'));
    });

    it('should not throw if Bugsnag sender throws', async () => {
      const failingSenders: MonitoringSenders = {
        sendTelegram: async () => {},
        sendBugsnag: async () => { throw new Error('Bugsnag down'); },
        sendEmail: async () => {},
      };
      const m = createMonitor({ product: 'kysigned', senders: failingSenders });
      await assert.doesNotReject(() => m.notifyCritical('test'));
    });

    it('should not throw if email sender throws', async () => {
      const failingSenders: MonitoringSenders = {
        sendTelegram: async () => {},
        sendBugsnag: async () => {},
        sendEmail: async () => { throw new Error('SES down'); },
      };
      const m = createMonitor({ product: 'kysigned', senders: failingSenders });
      await assert.doesNotReject(() => m.notifyCritical('test'));
    });
  });
});
