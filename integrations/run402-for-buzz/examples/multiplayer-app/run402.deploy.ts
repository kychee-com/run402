import { defineConfig, dir, nodeFunction, sqlFile } from "@run402/sdk/config";

export default defineConfig({
  database: {
    migrations: [
      sqlFile("db/001_feedback.sql", { id: "001_feedback" }),
      sqlFile("db/002_feedback_roles.sql", { id: "002_feedback_roles" }),
    ],
  },
  functions: {
    replace: {
      feedback: nodeFunction("functions/feedback.js", {
        config: { timeoutSeconds: 10, memoryMb: 128 },
      }),
      "feedback-admin": nodeFunction("functions/feedback-admin.js", {
        config: { timeoutSeconds: 10, memoryMb: 128 },
        requireRole: {
          table: "feedback_roles",
          idColumn: "user_id",
          roleColumn: "role",
          allowed: ["admin"],
          cacheTtl: 0,
        },
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
      {
        pattern: "/api/feedback/admin",
        methods: ["POST", "OPTIONS"],
        target: { type: "function", name: "feedback-admin" },
      },
    ],
  },
});
