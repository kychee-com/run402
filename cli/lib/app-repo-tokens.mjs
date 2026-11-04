/**
 * `run402 app-repos tokens <verb>`: a credential for one app repo, read or write,
 * that expires by itself. Help lives with `run402 app-repos --help`; thin shim over
 * `r.appRepos.createToken` and `revokeToken`, which send the project's service key.
 */
import { resolveProjectId } from "./config.mjs";
import { fail } from "./sdk-errors.mjs";
import { flagValue, failUnknownSubcommand } from "./argparse.mjs";
import { call, parse, tooMany } from "./app-repos.mjs";

const CREATE_USAGE = "run402 app-repos tokens create <name> --access read|write [--ttl <seconds>]";

export async function run(sub, args) {
  switch (sub) {
    case "create": return create(args);
    case "revoke": return revoke(args);
    default:
      failUnknownSubcommand("app-repos tokens", sub);
  }
}

async function create(args) {
  const { a, pos } = parse(args, ["--project", "--access", "--ttl"]);
  if (pos.length === 0) fail({ code: "BAD_USAGE", message: "Missing <name>.", hint: CREATE_USAGE });
  if (pos.length > 1) tooMany("tokens create", pos[1]);
  const access = flagValue(a, "--access");
  if (access !== "read" && access !== "write") fail({ code: "BAD_USAGE", message: "--access must be read or write.", hint: CREATE_USAGE });
  const ttl = flagValue(a, "--ttl");
  const ttlSeconds = ttl === null || ttl === undefined ? undefined : Number(ttl);
  if (ttlSeconds !== undefined && !Number.isInteger(ttlSeconds)) {
    fail({ code: "BAD_USAGE", message: "--ttl must be a whole number of seconds.", hint: "60 to 86400; the default is 3600." });
  }
  const projectId = resolveProjectId(flagValue(a, "--project"));
  await call((ar) => ar.createToken(projectId, pos[0], { access, ...(ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {}) }));
}

async function revoke(args) {
  const { a, pos } = parse(args, ["--project", "--repo"]);
  const repoName = flagValue(a, "--repo");
  if (pos.length === 0 || !repoName) fail({ code: "BAD_USAGE", message: "Missing <token_id> or --repo.", hint: "run402 app-repos tokens revoke <token_id> --repo <name>" });
  if (pos.length > 1) tooMany("tokens revoke", pos[1]);
  const projectId = resolveProjectId(flagValue(a, "--project"));
  await call((ar) => ar.revokeToken(projectId, repoName, pos[0]));
}
