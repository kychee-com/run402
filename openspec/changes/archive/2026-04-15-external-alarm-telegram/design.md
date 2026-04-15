# Design: external-alarm-telegram

## Design decisions

### DD-1: All alarms fan into one SNS topic, one Lambda, one Telegram chat

**Decision.** Single topic (`run402-alarms`), single Lambda (`run402-alarm-relay`), single destination (existing `agentdb/telegram-bot` chat).

**Why.** The user is a solo operator. Multi-channel routing (warn vs critical, on-call rotation, escalation) is infrastructure for a team that doesn't exist yet. KISS until proven otherwise.

**Tradeoff.** Every alarm — memory warning at 80%, gateway fully dead, 5xx burst — goes to the same chat with the same sound. If an incident cascades and fires all four alarms in 30 seconds, the operator gets four messages. That's fine. Grouping them into one "summary" message would be clever but adds a debounce window that can only delay the first page, which is the opposite of what we want.

### DD-2: Reuse `agentdb/telegram-bot` secret, not a new one

**Decision.** The Lambda calls `secretsmanager:GetSecretValue` on `agentdb/telegram-bot` (the same secret the gateway reads) and parses out `bot_token` and `chat_id`. No new secret.

**Why.** User directive. Also: one secret to rotate, not two. Alarms and gateway notifications share a bot, which is correct — there's one bot, one chat.

**Tradeoff.** If we ever split alarms off to a different chat, we need to either fork the secret or add a second key. Trivial to do later; not worth pre-building.

### DD-3: CloudWatch alarm evaluation period — 1 minute, 2 datapoints

**Decision.** Every alarm uses `period = 60s, evaluationPeriods = 2, datapointsToAlarm = 2`. This means "condition must be true for two consecutive 1-minute windows."

**Why.** CloudWatch's native metric resolution for ECS and ALB is 1-minute. Going finer is not available without Detailed Monitoring. Requiring two datapoints filters out single-minute blips (target-registration-in-progress during deploys, transient ALB 5xx during task cycling) without delaying real alarms beyond ~2.5 minutes from incident start.

**Tradeoff.** Today's OOM went 22% → 27% → 64% → 99% → dead in 5 minutes. With 2-of-2 at 80%, the alarm would have fired at the 09:24 datapoint (at 99%) — one minute before the kill, ~3 minutes after the first concerning bump at 09:22. Fine. Going to 1-of-1 would fire a minute earlier but produce more false positives during deploys.

### DD-4: Four alarms, not more

**Decision.** Exactly these four:

| Alarm | Metric | Threshold | Why |
|---|---|---|---|
| `run402-gateway-memory-high` | `AWS/ECS MemoryUtilization` (service dim) | `> 80%` | Catches memory pressure *before* OOM. 80% gives ~200 MB of headroom on a 1024 MB task. |
| `run402-gateway-task-count-low` | `AWS/ECS RunningTaskCount` (service dim) | `< 1` | Catches "gateway is down." Current desiredCount is 1; if that changes, the threshold moves accordingly (see DD-7). |
| `run402-alb-target-unhealthy` | `AWS/ApplicationELB UnHealthyHostCount` (target group dim) | `≥ 1` | Catches "ALB cannot reach gateway." Fires during OOM replacement and any other health-check failure. |
| `run402-alb-5xx-burst` | `AWS/ApplicationELB HTTPCode_Target_5XX_Count` (LB dim, SUM) | `> 10 per min` | Catches application-level 5xx waves that don't kill the task but do hurt users. |

**Why these four.** They cover the four distinct failure modes the gateway can exhibit: memory pressure before death, death itself, reachability between ALB and task, and application errors. Anything else is either a subset (CPU high ≈ likely also memory high) or outside liveness scope (RDS storage, Bugsnag error rate).

**Tradeoff.** `MemoryUtilization` and `UnHealthyHostCount` will both fire during a real OOM within ~60s of each other. That's expected and correct — we're not deduping (see DD-1).

### DD-5: Alarm message format

**Decision.** The Lambda formats each SNS message as:

```
🚨 run402-alarms
Alarm: {AlarmName}
State: {NewStateValue}  (was {OldStateValue})
Reason: {NewStateReason}
Metric: {MetricName}  {Threshold}
Time: {StateChangeTime}
Dashboard: https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:alarm/{AlarmName}
```

Recovery messages (`NewStateValue == "OK"`) get `✅` instead of `🚨`.

**Why.** Every field CloudWatch gives us in the SNS payload matches what an on-call operator wants to know in the first 10 seconds: *what broke, how bad, why, when, and where do I look*. Link to the alarm page is one tap away.

**Tradeoff.** Message is ~6 lines. Not optimized for a watch-sized notification. Operator reads on phone, not watch, so we optimize for completeness, not brevity.

### DD-6: Alarm Lambda runtime — Node.js 22.x, no bundler

**Decision.** The Lambda is a single `index.mjs` with native `fetch` (Node 22) and `@aws-sdk/client-secrets-manager` from the Node runtime's bundled SDK. No webpack, no esbuild, no layer.

**Why.** ~40 lines of code. Bundling is overkill. Node 22's bundled SDK is included in the runtime; we don't ship the `@aws-sdk/*` package.

**Tradeoff.** Cold start is ~200ms instead of ~80ms with a thin bundle. First alarm after a long idle period pays that cost. Not material for alerting latency where we're already at ~90s from incident → page.

### DD-7: Alarms deploy via existing pod-stack CDK

**Decision.** Add the SNS topic, Lambda, and four alarms to `infra/lib/pod-stack.ts` alongside the existing SES-events SNS topic. No new stack.

**Why.** The alarms reference ECS service and ALB target-group ARNs that are already first-class in `pod-stack.ts`. Creating a separate stack forces cross-stack references and a deploy ordering. The current stack is the right place.

**Tradeoff.** `pod-stack.ts` grows by ~80 lines. It's already 600+ lines; we've been talking about splitting it for other reasons. That's a separate refactor.

### DD-8: No alarm muting during planned deploys

**Decision.** Don't silence alarms during `./scripts/deploy.sh` or the GitHub Actions deploy workflow.

**Why.** The 2-datapoint evaluation already absorbs transient target-registration blips. A deploy that takes longer than 2 minutes to bring a task to healthy is a real problem worth paging on.

**Tradeoff.** We'll find out in testing whether the 2-datapoint threshold actually holds during deploys. If it doesn't, we bump to 3 datapoints before considering deploy-time muting.

## Open questions (deferred)

- **Future alarms using this pipe.** The SNS → Lambda pattern is reusable. Future work might add alarms for RDS CPU, Stripe webhook 4xx, Bugsnag error rate, faucet drainage. All go into the same topic and use the same Lambda unchanged. Not in this change.
- **Alarm message in other languages.** The operator is English-speaking. Not relevant.

## Testing strategy

The Lambda has one unit test (format a sample SNS event → expected Telegram payload, mock `fetch`) and one integration path: deploy, manually set an alarm to `ALARM` via CLI, confirm Telegram receives the message. No E2E suite — the runtime dependencies (CloudWatch, SNS, Lambda, Telegram) are all external services we're not going to mock in CI.

## File inventory

Files touched:

- `infra/lib/pod-stack.ts` — add SNS topic, Lambda construct, 4 CloudWatch Alarm constructs, IAM grants.
- `infra/alarm-relay/index.mjs` (new) — ~40 lines: parse SNS event, read secret, POST to Telegram.
- `infra/alarm-relay/index.test.mjs` (new) — one format-checking unit test.

Lambda source path follows the existing `infra/status-probe/` convention (sibling of `lib/`), not `infra/lambdas/<name>/`.

No gateway code changes. No secret changes. No DB migrations.
