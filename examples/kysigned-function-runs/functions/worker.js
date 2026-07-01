import {
  defineFunctionRuns,
  functions,
  permanentFunctionRunError,
  retryableFunctionRunError,
} from "@run402/functions";

export default defineFunctionRuns({
  "kysigned.forward.process": {
    async run(ctx, payload) {
      const messageId = requireString(payload, "message_id");
      const recipient = requireString(payload, "recipient");
      console.log(`forward ${messageId} to ${recipient}`);

      await functions.runs.create("worker", {
        eventType: "kysigned.reminder.send",
        payload: { message_id: messageId },
        delay: "10m",
        expiresAfter: "1d",
        idempotencyKey: key("reminder", messageId),
        retry: { preset: "standard", maxAttempts: 3 },
      });

      console.log(`run ${ctx.run.id} scheduled reminder for ${messageId}`);
    },
  },

  "kysigned.reminder.send": {
    async run(_ctx, payload) {
      const messageId = requireString(payload, "message_id");
      console.log(`send reminder for ${messageId}`);
    },
  },

  "kysigned.sweep.stale": {
    async run(_ctx, payload) {
      const batchSize = Number(payload?.batch_size ?? 25);
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
        throw permanentFunctionRunError("batch_size must be an integer from 1 to 100", "invalid_batch_size");
      }

      try {
        console.log(`sweep up to ${batchSize} stale messages`);
      } catch (err) {
        throw retryableFunctionRunError(err instanceof Error ? err.message : "stale sweep failed", "stale_sweep_failed");
      }
    },
  },
});

function requireString(value, field) {
  const raw = value?.[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw permanentFunctionRunError(`${field} is required`, "invalid_payload");
  }
  return raw;
}

function key(...parts) {
  return parts.map((part) => encodeURIComponent(String(part))).join(":");
}
