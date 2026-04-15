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

- [ ] 3.1 `cd infra && eval "$(aws configure export-credentials --profile kychee --format env)" && npx cdk diff AgentDB-Pod01` — confirm only the expected additions (1 topic, 1 subscription, 1 function, 4 alarms, IAM grants). No gateway/ECS changes. [ship]
- [ ] 3.2 `npx cdk deploy AgentDB-Pod01 --require-approval never` — deploy. [ship]
- [ ] 3.3 Verify in console: SNS topic `run402-alarms` exists, Lambda `Run402AlarmRelay-*` exists and is subscribed, 4 alarms exist in `INSUFFICIENT_DATA` or `OK` state. [manual]

## 4. Manual verification — alarm fires on state change

- [ ] 4.1 `AWS_PROFILE=kychee aws cloudwatch set-alarm-state --alarm-name Run402GatewayMemoryHigh --state-value ALARM --state-reason "manual test" --region us-east-1` — manually flip the alarm. Telegram message should arrive within 10s with 🚨 prefix. [manual]
- [ ] 4.2 `AWS_PROFILE=kychee aws cloudwatch set-alarm-state --alarm-name Run402GatewayMemoryHigh --state-value OK --state-reason "manual test recovery" --region us-east-1` — flip back. Telegram message should arrive with ✅ prefix. [manual]
- [ ] 4.3 Repeat 4.1 for each of the other three alarms to verify Telegram formatting works for each (metric name, threshold, and dashboard URL render correctly). [manual]

## 5. Real-world verification — gateway death

- [ ] 5.1 Find the running gateway task: `AWS_PROFILE=kychee aws ecs list-tasks --cluster AgentDB-Pod01-ClusterEB0386A7-qXAYbEVDllzd --service-name AgentDB-Pod01-ServiceD69D759B-Ko0ySLxS6H2Q --region us-east-1`. [manual]
- [ ] 5.2 Kill it: `aws ecs stop-task --cluster <cluster> --task <task-id> --region us-east-1`. [manual]
- [ ] 5.3 Observe: ECS auto-starts replacement (takes ~35s to healthy). During the gap, `UnHealthyHostCount` goes to 1 and `RunningTaskCount` goes to 0. Within ~2 minutes, the corresponding alarms fire and Telegram messages arrive. [manual]
- [ ] 5.4 After replacement completes, alarms return to OK → recovery messages arrive. [manual]
- [ ] 5.5 Confirm `api.run402.com/health` returns 200 (service fully restored). [manual]

## 6. Regression check — no false positive during CI deploy

- [ ] 6.1 Push a no-op commit to main (e.g. a README typo). The deploy-gateway workflow cycles the ECS task. [manual]
- [ ] 6.2 Watch the alarm states during the deploy window (roughly 2-3 minutes from target-draining to new target-healthy). Target-registration blips should NOT cross the 2-minute threshold. [manual]
- [ ] 6.3 If an alarm DID fire on a clean deploy, revisit DD-3 / DD-8 — increase `datapointsToAlarm` to 3, or add deploy-time muting. [manual]

## 7. Documentation

- [x] 7.1 Added new "External alarms (CloudWatch → Telegram)" section to `CLAUDE.md` with alarm table, console link, manual test command, and infra file pointers. [docs]
- [x] 7.2 Documented shared-secret semantics: `agentdb/telegram-bot` is consumed by both gateway and Lambda; rotation updates both on next invocation without redeploy. [docs]

## 8. Archive

- [ ] 8.1 After all checks pass in prod, move change directory to `openspec/changes/archive/YYYY-MM-DD-external-alarm-telegram/`. [manual]

## Implementation Log

_(Populate as tasks complete.)_
