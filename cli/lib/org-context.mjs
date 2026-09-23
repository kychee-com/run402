/**
 * Organization resolution for org-scoped CLI families: the CLI edge of
 * `r.orgs.resolve()` (`@run402/sdk/node`), which owns the precedence chain —
 * flag (`--org`, then `--project`), environment (`RUN402_ORG`, the org half of
 * `RUN402_ROOM`, then `RUN402_PROJECT_ID`), the `.run402.json` binding, this
 * checkout's vault pin, then profile state (`orgs use`, then the active
 * project). This module adds only what is CLI-shaped: reading the flags out of
 * argv, the leading `<org_id>` positional contract, the per-command conflict
 * exemption, and printing a refusal as the CLI's error envelope.
 *
 * `rooms`/`claims` resolve a PAIR ({orgId, roomKey}) with their own
 * `RUN402_ROOM` form — see `rooms-context.mjs`; only the org half of their
 * fallback delegates here.
 */
import { getSdk } from "./sdk.mjs";
import { flagValue, positionalArgs } from "./argparse.mjs";
import { fail, failLocal } from "./sdk-errors.mjs";
import { ORG_ID_RE, assertOrgIdShape, orgProvenance, orgRequiredError } from "#sdk/node";

export { ORG_ENV, ROOM_ENV, PROJECT_ENV, orgProvenance } from "#sdk/node";

/** Command groups that must stay usable while selection is ambiguous. */
const CONFLICT_EXEMPT = new Set(["orgs", "wallets", "doctor"]);

/** The refusals the resolver itself raises; anything else is the server's answer. */
const RESOLVER_CODES = new Set(["BAD_ORG_ID", "AMBIGUOUS_ORG", "ORG_REQUIRED"]);

const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Print a resolver refusal as the CLI envelope; rethrow a server or network error. */
function failResolver(err) {
  if (err?.kind === "local_error" && RESOLVER_CODES.has(err?.code)) failLocal(err);
  throw err;
}

/**
 * Resolve the organization an org-scoped command acts on.
 *
 * @param {string[]|object} input normalized argv (`--org`, `--project` read from it), or { org, project }
 * @param {object}  [opts]
 * @param {string}  [opts.cmd]      command group, for the conflict exemption
 * @param {object}  [opts.env]      environment (injectable for tests)
 * @param {string}  [opts.cwd]      directory to walk up from (injectable)
 * @param {boolean} [opts.optional] return null instead of failing when absent
 * @returns {Promise<{orgId: string, source: string, sourceDetail: string}|null>}
 */
export async function resolveOrg(input = {}, opts = {}) {
  const { cmd, env = process.env, cwd = process.cwd(), optional = false } = opts;
  const org = Array.isArray(input) ? flagValue(input, "--org") : input.org;
  const project = Array.isArray(input) ? flagValue(input, "--project") : input.project;
  try {
    return await getSdk().orgs.resolve({ org, project }, { env, cwd, optional, allowConflict: CONFLICT_EXEMPT.has(cmd) });
  } catch (err) {
    return failResolver(err);
  }
}

/** The addressed organization id from normalized argv (see {@link resolveOrg}). */
export async function resolveOrgId(a, opts = {}) {
  const resolved = await resolveOrg(a, opts);
  return resolved ? resolved.orgId : null;
}

/**
 * The org-scoped POSITIONAL contract: `<org_id>` is optional sugar on every
 * verb that acts on an organization. A leading positional that IS an org id
 * addresses that org; anything else is the verb's own next positional and the
 * org comes from the chain. Naming the org twice with different values
 * (positional AND `--org`) is `AMBIGUOUS_ORG`; a non-org first positional with
 * no chain answer fails `ORG_REQUIRED` naming the rejected value.
 *
 * Returns the org id with provenance plus the REMAINING positionals; bound
 * those with {@link requireRest}. Every `orgScoped` entry in the command
 * manifest is driven through this shape by `cli-conventions-gate.test.mjs`.
 *
 * @param {string[]} a          normalized argv
 * @param {string[]} valueFlags flags that take a value (must include "--org")
 * @param {object}   [opts]     forwarded to {@link resolveOrg} (cmd, env, cwd)
 */
export async function takeOrgPositional(a, valueFlags = [], opts = {}) {
  const positionals = positionalArgs(a, valueFlags);
  const first = positionals[0];
  if (typeof first === "string" && ORG_ID_RE.test(first)) {
    const flag = trimmed(flagValue(a, "--org"));
    if (flag && flag.toLowerCase() !== first.toLowerCase()) {
      fail({
        code: "AMBIGUOUS_ORG",
        message: `Ambiguous organization: positional ${first} but --org ${flag}.`,
        hint: "Name the organization once — as the leading <org_id> positional or as --org <org_id>, not both.",
        details: {
          candidates: [
            { org_id: first, source: "positional", source_detail: "<org_id>" },
            { org_id: flag, source: "flag", source_detail: "--org" },
          ],
        },
      });
    }
    return { orgId: first, rest: positionals.slice(1), source: "positional", sourceDetail: "<org_id>" };
  }
  const resolved = await resolveOrg(a, { ...opts, optional: true });
  if (resolved) return { orgId: resolved.orgId, rest: positionals, source: resolved.source, sourceDetail: resolved.sourceDetail };
  failLocal(orgRequiredError({ ...(typeof first === "string" ? { rejectedPositional: first } : {}), positionalHint: true }));
  return null; // unreachable — failLocal() exits
}

/**
 * Bound the positionals LEFT after {@link takeOrgPositional} took the org —
 * the same `BAD_USAGE` shapes `requirePositionalCount` emits, on an array the
 * caller already holds.
 */
export function requireRest(rest, opts = {}) {
  const { min = 0, max = min, command = "command", missing = "Missing required argument." } = opts;
  if (rest.length < min) {
    fail({ code: "BAD_USAGE", message: missing, hint: command });
  }
  if (rest.length > max) {
    fail({
      code: "BAD_USAGE",
      message: `Unexpected argument for ${command}: ${rest[max]}`,
      hint: `Use \`${command}\`.`,
    });
  }
  return rest;
}

/** Validate an org id supplied by a human, naming the origin. Exits on a bad shape. */
export function requireOrgIdShape(orgId, origin = "--org") {
  try {
    return assertOrgIdShape(orgId, origin);
  } catch (err) {
    return failResolver(err);
  }
}
