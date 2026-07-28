import { defineConfig, dir, nodeFunction, sqlFile } from "@run402/sdk/config";

export default defineConfig({
  database: {
    migrations: [sqlFile("db/001_feedback.sql", { id: "001_feedback" })],
    expose: ["feedback_items", "feedback_comments", "feedback_votes"],
  },
  functions: {
    replace: {
      feedback: nodeFunction("functions/feedback.js", {
        config: { timeoutSeconds: 10, memoryMb: 128 },
      }),
    },
  },
  site: {
    replace: dir("site"),
    public_paths: { mode: "implicit" },
  },
  routes: {
    replace: [
      {
        pattern: "/api/feedback",
        methods: ["GET", "POST", "OPTIONS"],
        target: { type: "function", name: "feedback" },
      },
    ],
  },
});
