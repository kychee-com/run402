import { defineConfig, nodeFunction, scheduleTrigger } from "@run402/sdk/config";

export default defineConfig({
  functions: {
    replace: {
      worker: nodeFunction("functions/worker.js", {
        config: { timeoutSeconds: 10, memoryMb: 128 },
        triggers: [
          scheduleTrigger("stale_sweep_every_15m", "*/15 * * * *", {
            run: {
              event_type: "kysigned.sweep.stale",
              payload: { batch_size: 25 },
              retry: { preset: "standard", max_attempts: 3 },
              expires_after_seconds: 900,
            },
          }),
        ],
      }),
    },
  },
});
