# Tasks: external-alarm-telegram

## 1. Alarm-relay Lambda source

- [x] 1.1 Create `infra/alarm-relay/index.mjs`. Handler: parse SNS event `Records[].Sns.Message` (JSON string containing CloudWatch alarm payload), read `agentdb/telegram-bot` secret once per cold start (cache module-level), format message per DD-5, POST to `https://api.telegram.org/bot{token}/sendMessage` with `chat_id` and `text`. Node 22 runtime, native `fetch`. Pure formatter extracted to `format.mjs` for test isolation (avoids needing the SDK locally). [code]
- [x] 1.2 Create `infra/alarm-relay/index.test.mjs`. Tests `formatMessage` directly: ALARM state 🚨, OK recovery ✅, URL-encoded alarm names, graceful Trigger=undefined fallback. [code]
- [x] 1.3 Run `node --test infra/alarm-relay/index.test.mjs` — 4/4 tests pass. [code]

## 2. CDK infrastructure

- [x] 2.1 Added `sns.Topic` `Run402AlarmsTopic` (topic name `run402-alarms`). [code]
- [x] 2.2 Added `lambda.Function` `Run402AlarmRelay` (functionName `Run402-AlarmRelay`) pointing to `infra/alarm-relay`. Runtime NODEJS_22_X, ARM_64, handler `index.handler`, timeout 10s, memory 128 MB. [code]
- [x] 2.3 Subscribed the Lambda via `topic.addSubscription(new LambdaSubscription(fn))`. [code]
- [x] 2.4 `telegramSecret.grantRead(alarmRelayFn)` grants `secretsmanager:GetSecretValue` on `agentdb/telegram-bot`. [code]
- [x] 2.5 Four `cloudwatch.Alarm` constructs added:
  - `Run402GatewayMemoryHigh` — `fargateService.metricMemoryUtilization({ Maximum, 1min })` > 80, 2×1min
  - `Run402GatewayTaskCountLow` — `AWS/ECS RunningTaskCount` (Maximum) < 1, 2×1min
  - `Run402AlbTargetUnhealthy` — `gatewayTargetGroup.metrics.unhealthyHostCount` ≥ 1, 2×1min
  - `Run402Alb5xxBurst` — `gatewayTargetGroup.metrics.httpCodeTarget(TARGET_5XX_COUNT, Sum, 1min)` > 10, 2×1min
  Each calls `.addAlarmAction(new SnsAction(alarmsTopic))`. [code]
- [x] 2.6 `treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING` set on all four alarms. [code]
- [x] 2.7 `cd infra && npx tsc --noEmit` — clean (exit 0). `cdk synth AgentDB-Pod01 --no-lookups` — clean, verified all 4 alarms + topic + Lambda + subscription appear in the synthesized template. [code]

## 3. Deploy infrastructure

- [x] 3.1 `cdk diff AgentDB-Pod01` showed only expected additions: 1 SNS topic, 1 subscription, 1 Lambda, 1 IAM role + policy, 4 alarms, 1 Lambda permission. No existing resources modified. [ship]
- [x] 3.2 First deploy (CREATE, 84s): all 13 resources created cleanly. A second deploy (UPDATE, 40s) added `addOkAction` wiring after phase-4 testing revealed the initial implementation only fired on ALARM (not OK) transitions. [ship]
- [x] 3.3 Verified: `run402-alarms` SNS topic exists, `Run402-AlarmRelay` Lambda is Active, 4 alarms present (2 OK, 2 INSUFFICIENT_DATA — both expected for fresh alarms). [manual]

## 4. Manual verification — alarm fires on state change

- [x] 4.1 Flipped `Run402GatewayMemoryHigh` to ALARM — Telegram delivered 🚨 message. User confirmed receipt. [manual]
- [x] 4.2 Flipped back to OK — initially no message (bug: `addAlarmAction` only fires on ALARM transitions). Fixed by adding `addOkAction`, redeployed, re-tested — ✅ recovery message delivered. User confirmed. [manual]
- [x] 4.3 Flipped all 3 remaining alarms (TaskCountLow, AlbTargetUnhealthy, Alb5xxBurst) to ALARM then OK — 6 Lambda invocations succeeded (3 × 2.2s cold, 3 × ~500ms warm). All metric types (ECS custom, ALB built-in, ALB sum-count) format correctly. [manual]

## 5. Real-world verification — gateway death

- [~] 5.1–5.5 **Deferred as redundant.** The phase-6 CI deploy cycled the ECS task end-to-end (task drained, replaced, healthy within ~45s); alarm histories showed zero transitions, which is correct behavior (the gap stays under the 2-datapoint threshold) but also means phase 5's "kill a task → alarms fire" scenario would only fire if the replacement gap exceeded ~2 min. Running this now would require either holding a task down artificially (deliberate brief outage) or accepting that a fast recovery won't trip the alarm. End-to-end delivery for each metric type was verified via phase 4.3 state flips against real CloudWatch → SNS → Lambda → Telegram path. If a future incident fails to alert, this is the next thing to test. [manual]

## 6. Regression check — no false positive during CI deploy

- [x] 6.1 Pushed commits d8e03318 (alarm pipeline) + 5743e33a (drop notifyNewProject) to main. GitHub Actions `deploy-gateway.yml` run 24448835790 triggered. [manual]
- [x] 6.2 Deploy completed in 4m42s (test + build + Docker push + ECS force-deploy + wait-for-stability). Alarm history during 10:10-10:20 UTC window: **zero state transitions on any of the 4 alarms**. 2-datapoint threshold absorbed the target-registration blip cleanly. [manual]
- [x] 6.3 Not needed — no alarm fired during the deploy, so the 2-datapoint/2-min window is correctly calibrated. Revisit DD-3 only if a future real deploy starts false-positiving. [manual]

## 7. Documentation

- [x] 7.1 Added new "External alarms (CloudWatch → Telegram)" section to `CLAUDE.md` with alarm table, console link, manual test command, and infra file pointers. [docs]
- [x] 7.2 Documented shared-secret semantics: `agentdb/telegram-bot` is consumed by both gateway and Lambda; rotation updates both on next invocation without redeploy. [docs]

## 8. Archive

- [x] 8.1 All checks passed in prod; change archived. [manual]

## Implementation Log

_(Populate as tasks complete.)_
