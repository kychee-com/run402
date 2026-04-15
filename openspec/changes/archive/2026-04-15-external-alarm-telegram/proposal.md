# Proposal: external-alarm-telegram

**Status:** Ready to implement
**Severity:** High — today the gateway OOM-crashed at 09:25 local and nobody was paged. The only reason we found out is a user noticed `/admin` returning 503. There is currently zero external alerting on run402 infrastructure. The next outage will also go undetected until someone happens to look.

## Problem

On 2026-04-15 the gateway task was OOM-killed (exit 137, 1024 MB hit). Memory had been flat at 22% for 10 hours; two operators opening `/admin/finance` concurrently triggered enough parallel Postgres work to blow heap in ~45 seconds. The task was auto-replaced by ECS in ~80 seconds, so the user-visible outage was brief — but:

- No page fired. No email. No Telegram. Nothing.
- Bugsnag catches *thrown errors*, not resource pressure or process death.
- CloudWatch has the data (we confirmed `MemoryUtilization` hit 99.5%) but no alarms are wired to it.
- An in-process alarm from the gateway itself wouldn't help: the gateway was the thing that died.

We need external alerting that survives gateway death.

## Scope

Build the minimum external alarm pipeline for **gateway liveness**. Four CloudWatch alarms fan into one SNS topic, which triggers one Lambda that posts to the existing Telegram bot chat.

Explicit non-goals:

- **Synthetic HTTP probe.** The ALB already runs a health check against `/health` every 30s; the `UnHealthyHostCount` CloudWatch metric is the same information a synthetic probe would give us, without a second Lambda to own.
- **Severity routing.** All alarms → one chat. KISS. If noise becomes a problem we split later.
- **Dedup / flap suppression.** Same reason.
- **Alarms for non-liveness concerns** (Bugsnag error bursts, RDS storage, x402 facilitator auth, Stripe webhook failures). All valid but scope creep. The pipe built here can carry future alarms; we just don't wire them in this change.

## What gets built

```
  CloudWatch Alarms         SNS Topic            Lambda               Telegram
  ─────────────────         ─────────            ──────               ────────
  ┌───────────────────────┐
  │ MemoryUtilization     │
  │   > 80% for 2 min     │──┐
  └───────────────────────┘  │
  ┌───────────────────────┐  │
  │ RunningTaskCount      │  │   ┌──────────────┐   ┌──────────────┐   ┌──────────┐
  │   < DesiredCount      │──┼──▶│ run402-alarms│──▶│ alarm-relay  │──▶│ bot API  │
  │   for 2 min           │  │   │ (SNS topic)  │   │ (Node.js 22) │   │ sendMsg  │
  └───────────────────────┘  │   └──────────────┘   └──────────────┘   └──────────┘
  ┌───────────────────────┐  │                                              ▲
  │ ALB HTTPCode_Target   │  │                                              │
  │   _5XX_Count          │──┤                                              │
  │   > 10 / 1 min        │  │                     reuses existing:         │
  └───────────────────────┘  │                     agentdb/telegram-bot     │
  ┌───────────────────────┐  │                     (bot_token + chat_id)    │
  │ UnHealthyHostCount    │  │                                              │
  │   ≥ 1 for 2 min       │──┘                                              │
  └───────────────────────┘
```

4 alarms → 1 topic → 1 Lambda → 1 chat.

## Why this shape

**Why CloudWatch alarms, not a cron-scheduled synthetic probe Lambda?**

The ALB already hits `/health` every 30s (that's what `/health` is for). `UnHealthyHostCount` is the ALB's own verdict on whether the gateway is reachable and returning 2xx. Adding a second Lambda that does the same thing is duplicate work. Tradeoff: CloudWatch has a ~60-120s alarm-evaluation delay so we lose some latency vs. a synthetic probe that could evaluate in-band. We accept that — a page 2 minutes after death is infinitely better than no page at all.

**Why reuse the existing `agentdb/telegram-bot` secret, not a new one?**

User directive: reuse the bot token already in use. The secret holds `{ bot_token, chat_id }` and is already read by the gateway. The alarm-relay Lambda gets `secretsmanager:GetSecretValue` on the same ARN. Posting from two sources to one chat is fine — messages are distinguishable by content (Telegram `sendMessage` lets us prefix `🚨` vs `🆕`).

**Why Lambda, not an SNS → HTTPS subscription directly to `api.telegram.org`?**

SNS raw HTTPS subscriptions exist but have no templating: we'd POST CloudWatch's raw JSON to Telegram, which renders as gibberish. The Lambda exists solely to format the alarm payload into a human-readable message. ~40 lines of code.

## Non-goals

- **Admin health strip on `/admin`.** Separate change (`admin-health-strip`) — that's in-process observability. This change is external.
- **Paging escalation (PagerDuty, phone call).** Telegram is enough for a solo operator.
- **Alarm state dashboard.** CloudWatch already has one at `console.aws.amazon.com/cloudwatch/home#alarms`.
- **Multi-region replication of alarms.** Single-region (us-east-1) matches the pod.

## Alternatives considered

1. **Pingdom / UptimeRobot / healthchecks.io.** Zero code, 1-min polling, Telegram built-in. Rejected on cost (~$10-30/mo) and vendor lock — we have all the primitives in AWS already.
2. **Scheduled EventBridge → Lambda → `GET /health` + Telegram on failure.** Second Lambda duplicating what ALB already does. Rejected.
3. **In-process heartbeat to DynamoDB with dead-man's switch Lambda.** Elegant but overkill. Catches "hung but not OOM" which nothing else does — but we don't have evidence that's a real failure mode for this service.
4. **Gateway posts to Telegram directly on startup/shutdown signals.** Partial — covers graceful shutdown but not OOM (the kernel sends SIGKILL, no JS handler runs). Rejected.

## Verification

- **Alarm fires on manual trigger.** `aws cloudwatch set-alarm-state --alarm-name run402-memory-high --state-value ALARM --state-reason "manual test"` → Telegram message arrives in chat within ~10s.
- **Alarm fires on real memory pressure.** `stress-ng` inside an ECS exec session to push memory over 80% → alarm enters ALARM → Telegram message arrives.
- **Alarm recovers.** After the stress ends and memory drops, alarm returns to OK → Telegram sends an "OK" message (or not — see design.md for the recovery-message decision).
- **Gateway-dead path.** Kill the running ECS task with `aws ecs stop-task`. `RunningTaskCount < DesiredCount` alarm fires within 2 min → Telegram message. Task auto-replacement brings us back to OK.
- **No false positives during deploys.** When CI deploys a new image, ECS cycles tasks; `UnHealthyHostCount` briefly hits 1 during target-registration. Alarm threshold (≥1 for **2 min**) must not trip. Verify by watching a real deploy after the alarm is live.

## Backout

Revert the CDK change; the alarms, SNS topic, and Lambda all destroy cleanly. Telegram chat gets no further alarms, gateway otherwise unaffected.
