/**
 * CLI-side SDK getter.
 *
 * Constructs a fresh Node-flavored SDK on each call. Each CLI invocation is
 * typically a single process, so a fresh instance per subcommand is cheap
 * and sidesteps stale-env issues in tests that mutate RUN402_CONFIG_DIR /
 * RUN402_API_BASE between runs.
 */

import { run402 } from "#sdk/node";
import { walletFile, profileStateFile, projectCredentialsFile } from "./config.mjs";

let projectAuth = "principal";

/** `--use-service-key`: send the project's cached service key on project commands. */
export function setProjectAuth(mode) {
  projectAuth = mode;
}

/** The current project-auth mode (the git helper persists `--use-service-key` from it). */
export function getProjectAuth() {
  return projectAuth;
}

export function getSdk(opts = {}) {
  // surface: "cli" opts the default credential resolution into `auto` — wallet
  // if present, else the sign-in session + a matched write approval.
  return run402({
    surface: "cli",
    walletPath: walletFile(),
    keystorePath: projectCredentialsFile(),
    profileStatePath: profileStateFile(),
    ...(projectAuth === "service_key" ? { projectAuth } : {}),
    ...opts,
  });
}
