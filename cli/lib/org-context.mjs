/**
 * Shared organization resolution for org-scoped CLI families
 * (attention-architecture Wave E — one resolver, not one per family;
 * extended by add-cli-current-org with the local-context classes).
 *
 * The org is the ownership root — it owns projects, holds memberships, and is
 * the scope for rooms, escalations, members, grants, and audit. This is the one
 * place org precedence is expressed.
 *
 * Precedence is four INTENT CLASSES, highest first, and inside each class an
 * organization named directly outranks one derived from a project named in that
 * same class:
 *
 *   1. flag          --org <org_id>           else --project <id> -> its org
 *   2. environment   RUN402_ORG, else the org else RUN402_PROJECT_ID -> its org
 *                    half of RUN402_ROOM
 *   3. binding       the `org` key of the nearest .run402(.local).json
 *   4. profile state the profile's selected org else its active project -> org
 *
 * The class rule is what makes `--project X` behave: naming a project IS naming
 * its organization, so a stale profile selection must not outrank it. Classes 3
 * and 4 are what let an org that owns NO project be addressed at all — every
 * earlier rung needed an argument, a variable, or a deployed project.
 *
 * `rooms`/`claims` resolve a PAIR ({orgId, roomKey}) with their own
 * `RUN402_ROOM` env form — see `rooms-context.mjs`. They are not forced through
 * this single-value resolver: the pair keeps its own shape and its own
 * precedence, and only the ORG HALF of its fallback delegates here. One
 * resolver per shape, composed for the half they share.
 *
 * Two things this deliberately does NOT do:
 * - Infer the org from the caller's memberships, at any count. Membership is
 *   server state that changes without the caller acting, so a heuristic that is
 *   right today silently changes meaning the day they are invited elsewhere.
 * - Validate membership locally. A well-formed id goes to the server and the
 *   server's answer is surfaced as returned — never rewritten into a local
 *   not-found (that would invent the existence oracle the gateway refuses to
 *   provide) and never retried against a lower class (that would act on a
 *   different organization than the caller named).
 */
import { getSdk } from "./sdk.mjs";
import { flagValue } from "./argparse.mjs";
import { findBindingKey } from "./wallet-context.mjs";
import { fail } from "./sdk-errors.mjs";
import { nextAction } from "./next-actions.mjs";
import { describeRejectedValue } from "../core-dist/redact.js";
import {
  getActiveOrgId as coreGetActiveOrgId,
  setActiveOrgId as coreSetActiveOrgId,
  clearActiveOrgId as coreClearActiveOrgId,
} from "../core-dist/profile-state.js";
import { getActiveProjectId } from "../core-dist/keystore.js";
import { getProject, resolveProjectId, updateProject } from "./config.mjs";

export const ORG_ENV = "RUN402_ORG";
export const ROOM_ENV = "RUN402_ROOM";
export const PROJECT_ENV = "RUN402_PROJECT_ID";

/** Command groups that must stay usable while selection is ambiguous. */
const CONFLICT_EXEMPT = new Set(["org", "wallets", "doctor"]);

/** `org_id` is a UUID at every API boundary (`uuidParam` on every route). */
const ORG_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const trimmed = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Shape-validate an organization id supplied by a local source. Membership is
 * NEVER checked here — only that the value could be an org id at all.
 *
 * A rejected value is a value we know nothing about — see
 * core-dist/redact.js's doc comment (kychee-com/run402-private#640): the
 * same class of mistake that put a private key into RUN402_WALLET can put
 * one into RUN402_ORG / --org, so this must never echo the raw value.
 */
function assertOrgIdShape(orgId, origin) {
  if (ORG_ID_RE.test(orgId)) return orgId;
  fail({
    code: "BAD_ORG_ID",
    message: `Invalid organization id ${JSON.stringify(describeRejectedValue(orgId))} (from ${origin}).`,
    hint: "An org_id is a UUID. Run 'run402 org list' to see the organizations you belong to.",
    details: { org_id: describeRejectedValue(orgId), origin },
    next_actions: [listOrgsAction()],
  });
}

/** The org half of `RUN402_ROOM=<org_id>/<room_key>`, or null. */
function orgFromRoomEnv(env) {
  const raw = trimmed(env[ROOM_ENV]);
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null; // rooms-context reports the malformed form
  return raw.slice(0, slash);
}

function listOrgsAction() {
  return nextAction("edit_request", {
    command: "run402 org list",
    why: "List the organizations this wallet belongs to.",
  });
}

function orgRequiredActions() {
  return [
    nextAction("edit_request", {
      command: "run402 org use <org_id>",
      why: "Select a current organization for this wallet profile.",
    }),
    listOrgsAction(),
    nextAction("edit_request", {
      command: "run402 <command> --org <org_id>",
      why: "Name the organization on this one call.",
    }),
    nextAction("edit_request", {
      command: "export RUN402_ORG=<org_id>",
      why: "Name the organization for every call in this shell (harness wiring).",
    }),
    nextAction("edit_request", {
      command: `echo '{"org":"<org_id>"}' > .run402.json`,
      why: "Bind this checkout to an organization so every agent in it inherits the same one.",
    }),
    nextAction("edit_request", {
      command: "run402 projects use <project_id>",
      why: "Select a project; its owning organization becomes the current one.",
    }),
  ];
}

/** Resolve a project's owning org (one GET). Returns null when unresolvable. */
async function orgOfProject(projectId, { required }) {
  // Upstream's per-project cache answers the same question for free when it is
  // warm. It is NOT used as the whole implementation: it returns null on
  // failure, and an explicitly named project must be able to HARD STOP rather
  // than fall through to a lower class.
  const cached = getProject(projectId)?.org_id;
  if (typeof cached === "string" && cached.length > 0) return cached;
  try {
    const scoped = await getSdk().rooms.forProject(projectId);
    return scoped.orgId;
  } catch (err) {
    // An EXPLICITLY named project that cannot be resolved is a hard stop — the
    // caller named it, so falling to a lower class would act on a different
    // organization than the one they asked for. An implicitly selected project
    // (profile state) may simply be stale; skip the class.
    if (!required) return null;
    throw err;
  }
}

/**
 * Resolve the organization an org-scoped command acts on.
 *
 * Accepts either normalized argv (the Wave E call shape, still used by
 * `escalations`) or an options object for callers that already hold values.
 *
 * @param {string[]|object} input normalized argv, or { org, project }
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

  // --- Class 1: flag -------------------------------------------------------
  const orgFlag = trimmed(org);
  if (orgFlag) {
    return { orgId: assertOrgIdShape(orgFlag, "--org"), source: "flag", sourceDetail: "--org" };
  }
  const projectFlag = trimmed(project);
  if (projectFlag) {
    const orgId = await orgOfProject(projectFlag, { required: true });
    if (orgId) return { orgId, source: "flag", sourceDetail: "--project" };
  }

  // --- Class 2 and 3: environment vs binding (the conflict pair) ------------
  const bindingHit = findBindingKey(cwd, "org");
  const bindingOrg = bindingHit ? assertOrgIdShape(bindingHit.value, bindingHit.file) : null;

  const envDirect = trimmed(env[ORG_ENV]);
  const envRoomOrg = envDirect ? null : orgFromRoomEnv(env);
  const envProject = envDirect || envRoomOrg ? null : trimmed(env[PROJECT_ENV]);

  let envOrg = null;
  let envDetail = null;
  if (envDirect) {
    envOrg = assertOrgIdShape(envDirect, ORG_ENV);
    envDetail = ORG_ENV;
  } else if (envRoomOrg) {
    envOrg = assertOrgIdShape(envRoomOrg, ROOM_ENV);
    envDetail = ROOM_ENV;
  } else if (envProject && bindingOrg) {
    // Only worth a lookup when a binding exists to disagree with; otherwise the
    // env class wins uncontested and the lookup happens once, below.
    envOrg = await orgOfProject(envProject, { required: false });
    envDetail = PROJECT_ENV;
  }

  if (envOrg && bindingOrg && envOrg !== bindingOrg && !CONFLICT_EXEMPT.has(cmd)) {
    // The wallet tier's rule, scoped to the same pair. A binding deliberately
    // declared by a checkout outranks the profile's selection SILENTLY — that
    // is what a binding is for — but an ambient env var disagreeing with a
    // committed file is exactly the surprise worth stopping on.
    fail({
      code: "AMBIGUOUS_ORG",
      message: `Ambiguous organization: ${envDetail}=${envOrg} but ${bindingHit.file} binds ${bindingOrg}.`,
      hint: `Resolve with one of: pass --org <org_id>, unset ${envDetail}, or edit the binding file.`,
      details: {
        candidates: [
          { org_id: envOrg, source: "env", source_detail: envDetail },
          { org_id: bindingOrg, source: "binding", source_detail: bindingHit.file },
        ],
      },
      next_actions: [
        nextAction("edit_request", {
          command: "run402 <command> --org <org_id>",
          why: "The flag resolves the conflict for this call.",
        }),
      ],
    });
  }

  if (envOrg) return { orgId: envOrg, source: "env", sourceDetail: envDetail };
  if (envProject) {
    const orgId = await orgOfProject(envProject, { required: false });
    if (orgId) return { orgId, source: "env", sourceDetail: PROJECT_ENV };
  }
  if (bindingOrg) return { orgId: bindingOrg, source: "binding", sourceDetail: bindingHit.file };

  // --- Class 4: profile state ----------------------------------------------
  const selected = trimmed(coreGetActiveOrgId());
  if (selected) {
    return { orgId: assertOrgIdShape(selected, "org use"), source: "profile", sourceDetail: "org use" };
  }
  const activeProject = trimmed(getActiveProjectId());
  if (activeProject) {
    const orgId = await orgOfProject(activeProject, { required: false });
    if (orgId) return { orgId, source: "profile", sourceDetail: "projects use" };
  }

  if (optional) return null;
  fail({
    code: "ORG_REQUIRED",
    message: "No organization specified and no current organization set.",
    hint: `Pass --org <org_id>, set ${ORG_ENV}, bind this directory in .run402.json, or run: run402 org use <org_id>`,
    next_actions: orgRequiredActions(),
  });
  return null; // unreachable — fail() exits
}

/**
 * Resolve the addressed organization id from normalized argv.
 *
 * The Wave E signature, preserved: callers that only need the id keep passing
 * argv and getting a string back. Use {@link resolveOrg} when the provenance
 * pair is wanted too.
 */
export async function resolveOrgId(a, opts = {}) {
  const resolved = await resolveOrg(a, opts);
  return resolved ? resolved.orgId : null;
}

/** Validate an org id supplied by a human, naming the origin. Throws via fail(). */
export function requireOrgIdShape(orgId, origin = "--org") {
  return assertOrgIdShape(orgId, origin);
}

/** The profile's selected organization, without running the chain. */
export function getSelectedOrgId() {
  return trimmed(coreGetActiveOrgId());
}

/** Record the profile's selected organization. */
export function setSelectedOrgId(orgId, origin = "org use") {
  coreSetActiveOrgId(assertOrgIdShape(orgId, origin));
}

/** Clear the profile's selected organization. */
export function clearSelectedOrgId() {
  coreClearActiveOrgId();
}

/**
 * Stamp a project's owning organization as the profile selection.
 *
 * Called by `projects use`: a project determines its organization
 * unambiguously, so selecting one keeps the two lowest classes from ever
 * disagreeing in practice — and gives an existing user a current org without
 * reading a changelog. Best-effort: a failure here must never fail the project
 * selection the caller actually asked for.
 */
export async function stampOrgFromProject(projectId) {
  try {
    const orgId = await orgOfProject(projectId, { required: false });
    if (orgId) {
      coreSetActiveOrgId(orgId);
      return orgId;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

/** Provenance pair for command output: bounded, never a resolution trace. */
export function orgProvenance(resolved) {
  return resolved
    ? { org_id: resolved.orgId, org_source: resolved.source, org_source_detail: resolved.sourceDetail }
    : { org_id: null, org_source: null, org_source_detail: null };
}

/**
 * The organization that OWNS a specific project, or `null`.
 *
 * Distinct from {@link resolveOrgId}: that one answers "which org is this
 * command addressed at" (flag → env → active project); this one answers "who
 * owns THIS project id", which is what a project-scoped scaffold needs and
 * where an `--org` override would be a mis-binding, not a convenience.
 *
 * WHY IT CACHES (task 5.12c): the gitvault scaffold is the one part of
 * `run402 init` the client-surface spec says adds no network dependency to the
 * cold-start path, and resolving the org through `projects.list()` quietly made
 * that untrue. `org_id` is a non-secret routing identifier the control plane
 * already hands back with every listing, so the honest fix is to remember it —
 * the FIRST call on a machine still asks, every returning one reads it locally.
 *
 * Cached in the local project entry after the first lookup, and an EXACT id
 * match is required: a near-miss must never bind a vault or a git remote to
 * somebody else's project. `updateProject` is a no-op for a project this
 * machine holds no credentials for, so such a project asks again next time
 * rather than being silently mis-cached. Returns `null` rather than throwing —
 * every caller has something better to say than a stack trace.
 */
export async function resolveOwningOrgId(projectId) {
  const cached = getProject(projectId)?.org_id;
  if (typeof cached === "string" && cached.length > 0) return cached;
  try {
    const listed = await getSdk().projects.list();
    const rows = Array.isArray(listed?.projects) ? listed.projects : [];
    const row = rows.find((p) => (p?.id ?? p?.project_id) === projectId);
    const orgId = row?.org_id;
    if (typeof orgId !== "string" || orgId.length === 0) return null;
    try {
      updateProject(projectId, { org_id: orgId });
    } catch {
      // Caching is an optimization; a read-only or contended keystore costs a
      // round trip next time and must never fail the caller.
    }
    return orgId;
  } catch {
    return null;
  }
}
