## ADDED Requirements

### Requirement: External alarm pipeline for gateway liveness

The system SHALL page an operator via Telegram when the run402 gateway exhibits a liveness failure. The pipeline SHALL be external to the gateway process, so that a page fires even when the gateway itself is dead, hung, or unreachable.

#### Scenario: Gateway memory exceeds the warning threshold

- **GIVEN** the gateway ECS task is running with a 1024 MB memory limit
- **WHEN** `AWS/ECS MemoryUtilization` for the `AgentDB-Pod01-Service*` service reports > 80% for two consecutive 1-minute windows
- **THEN** a CloudWatch alarm named `Run402GatewayMemoryHigh` SHALL transition to `ALARM`
- **AND** the `run402-alarms` SNS topic SHALL receive the alarm notification
- **AND** the `run402-alarm-relay` Lambda SHALL post a message to the configured Telegram chat within 60 seconds of the state change
- **AND** the Telegram message SHALL begin with `🚨`, name the alarm, state the threshold, and include a link to the alarm's CloudWatch console page

#### Scenario: Gateway task count drops below desired

- **GIVEN** the ECS service desired count is ≥ 1
- **WHEN** `AWS/ECS RunningTaskCount` drops below the desired count for two consecutive 1-minute windows
- **THEN** the `Run402GatewayTaskCountLow` alarm SHALL fire
- **AND** a Telegram message SHALL be sent as in the memory scenario

#### Scenario: ALB cannot reach the gateway

- **WHEN** `AWS/ApplicationELB UnHealthyHostCount` on the gateway target group reports ≥ 1 for two consecutive 1-minute windows
- **THEN** the `Run402AlbTargetUnhealthy` alarm SHALL fire
- **AND** a Telegram message SHALL be sent

#### Scenario: Application 5xx burst

- **WHEN** `AWS/ApplicationELB HTTPCode_Target_5XX_Count` (SUM per 1-minute window) exceeds 10 for two consecutive windows
- **THEN** the `Run402Alb5xxBurst` alarm SHALL fire
- **AND** a Telegram message SHALL be sent

#### Scenario: Alarm recovers

- **WHEN** any alarm in the set transitions from `ALARM` back to `OK`
- **THEN** the `run402-alarm-relay` Lambda SHALL post a recovery message to the same Telegram chat within 60 seconds
- **AND** the recovery message SHALL begin with `✅` instead of `🚨`

#### Scenario: Multiple alarms fire concurrently

- **WHEN** two or more alarms enter `ALARM` within the same minute (e.g. during an OOM, both `MemoryHigh` and `AlbTargetUnhealthy` fire)
- **THEN** each alarm SHALL produce its own Telegram message
- **AND** messages SHALL NOT be deduplicated, grouped, or suppressed

### Requirement: Alarm-relay Lambda reuses the gateway's Telegram secret

The alarm-relay Lambda SHALL NOT provision a new Telegram bot or chat. It SHALL read credentials from the same Secrets Manager secret the gateway uses.

#### Scenario: Lambda reads bot token from shared secret

- **WHEN** the `run402-alarm-relay` Lambda invokes
- **THEN** it SHALL call `secretsmanager:GetSecretValue` on `agentdb/telegram-bot`
- **AND** it SHALL extract `bot_token` and `chat_id` fields from the secret JSON
- **AND** it SHALL NOT read any other secret

#### Scenario: Secret rotation propagates without redeploy

- **WHEN** the `bot_token` or `chat_id` value in `agentdb/telegram-bot` is rotated
- **THEN** the next cold-start invocation of the alarm-relay Lambda SHALL use the new value
- **AND** no CDK redeploy or Lambda env-var change SHALL be required

### Requirement: Alarm pipeline survives gateway death

The alarm pipeline's execution path SHALL NOT depend on the gateway being alive or reachable.

#### Scenario: Gateway process is dead

- **GIVEN** the gateway ECS task has been OOM-killed and not yet replaced
- **WHEN** any CloudWatch alarm in the set fires
- **THEN** the SNS → Lambda → Telegram path SHALL complete successfully without touching the gateway
- **AND** the operator SHALL receive a Telegram message

#### Scenario: Gateway ALB target is unhealthy

- **GIVEN** the ALB reports all gateway targets as unhealthy
- **WHEN** `UnHealthyHostCount ≥ 1` fires the corresponding alarm
- **THEN** the Lambda SHALL successfully deliver the Telegram message via `api.telegram.org` without routing through the gateway or the ALB

### Requirement: Alarm evaluation tolerates routine deploys

The alarm thresholds SHALL NOT fire during a normal rolling deploy of the gateway.

#### Scenario: Rolling deploy completes within the alarm tolerance window

- **GIVEN** a clean `main` deploy cycles the ECS task (draining old → registering new → healthy)
- **WHEN** the deploy completes within 2 minutes of target-draining to new-target-healthy
- **THEN** NO alarm SHALL transition to `ALARM`
- **AND** NO Telegram message SHALL be sent
