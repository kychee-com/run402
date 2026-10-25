/**
 * Astro middleware entry for `run402 dev --as <label>` (see dev-session.ts).
 *
 * Registered by the adapter only under `astro dev`. The `import.meta.env.DEV`
 * check is a second fence: Vite sets it to `false` in every build, so even a
 * build that somehow reached this module would serve requests untouched.
 */

import { runWithContext } from "@run402/functions";

import {
  createDevSessionHandler,
  DEV_TEST_SESSION_ENV,
  parseDevTestSession,
  type RunWithContext,
} from "./dev-session.js";

const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
const raw = process.env[DEV_TEST_SESSION_ENV];

const handle =
  isDev && raw
    ? createDevSessionHandler({
        session: parseDevTestSession(raw),
        runWithContext: runWithContext as unknown as RunWithContext,
      })
    : null;

export function onRequest(
  context: { request: Request },
  next: () => Promise<Response>,
): Promise<Response> {
  return handle ? handle(context.request, next) : next();
}
