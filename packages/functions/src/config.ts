// Read env vars lazily (on access, not import time) so that:
// 1. Local dev can set process.env before each invocation
// 2. Module caching doesn't freeze config from the first import
export const config = {
  get API_BASE() { return process.env.RUN402_API_BASE || "https://api.run402.com"; },
  get PROJECT_ID() { return process.env.RUN402_PROJECT_ID || ""; },
  get SERVICE_KEY() { return process.env.RUN402_SERVICE_KEY || ""; },
  get JWT_SECRET() { return process.env.RUN402_JWT_SECRET || ""; },
};
