/**
 * EvilMe deploy hook (demos keyless CI/CD).
 *
 * Astro SSR apps don't fit the demos' generic static/function engine — they need
 * an `astro build` + the @run402/astro release-slice (bundled SSR Lambda + the
 * static client dir). The canonical, supported path is the run402 CLI itself:
 * inside GitHub Actions it exchanges the OIDC token for a CI session, dynamically
 * imports @run402/astro/release-slice, esbuild-bundles the SSR entry, roots the
 * site at dist/run402/client/, and ships the DB migrations from run402.config.json
 * — all as one atomic apply. We dogfood exactly that command.
 *
 * Invoked by demos/_deploy/deploy.mjs as deploy({ baseUrl, auth, config }).
 */
import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface DeployArgs {
  baseUrl: string;
  auth: { mode: "ci"; token: string } | { mode: "wallet"; [k: string]: unknown };
  config: { project_id: string; subdomain: string; [k: string]: unknown };
}

export async function deploy({ config }: DeployArgs): Promise<{ status: string; release_id: string | null }> {
  const appDir = dirname(fileURLToPath(import.meta.url));
  const run = (cmd: string, env: NodeJS.ProcessEnv = process.env) =>
    execSync(cmd, { cwd: appDir, stdio: "inherit", env });

  // 1. Install + build → dist/run402/{client,server,adapter.json}. The run402
  //    Astro adapter needs the target project id at BUILD time (it templates
  //    image-variant + asset URLs to the project's CDN), so inject it.
  run("npm ci");
  run("npm run build", { ...process.env, RUN402_PROJECT_ID: config.project_id });

  // 2. One atomic apply: DB migrations (run402.config.json) + the Astro site +
  //    the class:"ssr" function (from dist). The CLI performs the GitHub
  //    OIDC → CI-session exchange itself when it detects the Actions env, so no
  //    bearer plumbing is needed here. Routes are omitted by the Astro slice
  //    (the gateway routes unmatched paths to the ssr function), so this stays
  //    inside what a CI OIDC session is allowed to ship.
  run(`npx --yes run402 deploy apply --dir dist --manifest run402.config.json --project ${config.project_id} --final-only`);

  return { status: "ready", release_id: null };
}
