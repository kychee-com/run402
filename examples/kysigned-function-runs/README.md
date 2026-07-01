# Kysigned-Style Function Runs

This fixture replaces a cron sweep architecture with Run402 durable function runs. A schedule trigger enqueues `kysigned.sweep.stale`; message/webhook handlers enqueue exact work items with stable idempotency keys; delayed reminders, status checks, logs, cancel, and redrive all use the same function-run surface.

Deploy:

```sh
run402 deploy apply --manifest run402.deploy.ts --project "$PROJECT_ID"
```

Create one durable work item:

```sh
run402 functions runs create "$PROJECT_ID" worker \
  --event-type kysigned.forward.process \
  --idempotency-key "forward:msg_123" \
  --payload-json '{"message_id":"msg_123","recipient":"alice@example.com"}' \
  --wait
```

Exercise operations:

```sh
run402 functions runs list "$PROJECT_ID" worker --event-type kysigned.forward.process
run402 functions runs logs "$PROJECT_ID" fnrun_...
run402 functions runs create "$PROJECT_ID" worker --event-type kysigned.reminder.send --idempotency-key "reminder:msg_123" --payload-json '{"message_id":"msg_123"}' --delay 10m
run402 functions runs cancel "$PROJECT_ID" fnrun_...
run402 functions runs redrive "$PROJECT_ID" fnrun_... --wait
```

Manual schedule-trigger run:

```sh
curl -X POST "https://api.run402.com/projects/v1/admin/$PROJECT_ID/functions/worker/triggers/stale_sweep_every_15m/run" \
  -H "apikey: $SERVICE_KEY"
```

The important architecture point: Kysigned no longer needs its own cron table or polling loop. Run402 stores each durable request, retries retryable attempts, exposes `fnrun_...` logs, and lets the app redrive a terminal item without inventing a queue noun.
