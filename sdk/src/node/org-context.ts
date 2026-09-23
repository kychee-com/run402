/**
 * Organization context, owned by the Node SDK: the ONE resolver every
 * org-scoped command consumes, and the verbs that select, report, and bind
 * the current organization.
 *
 * The org is the ownership root — it owns projects, holds memberships, and is
 * the scope for rooms, escalations, members, grants, and audit. Precedence is
 * four INTENT CLASSES, highest first, and inside each class an organization
 * named directly outranks one derived from a project named in that same class:
 *
 *   1. flag          `org` (--org)                 else `project` (--project) -> its org
 *   2. environment   RUN402_ORG, else the org half else RUN402_PROJECT_ID -> its org
 *                    of RUN402_ROOM
 *   3. binding       the `org` key of the nearest .run402(.local).json
 *   3.5 vault pin    `r402.orgId` in this checkout's local git config
 *   4. profile state the profile's selected org else its active project -> org
 *
 * Naming a project IS naming its organization, so a stale profile selection
 * never outranks it; classes 3 and 4 are what let an org that owns no project
 * be addressed at all.
 *
 * Two things this deliberately does NOT do:
 * - Infer the org from the caller's memberships, at any count: membership is
 *   server state that changes without the caller acting.
 * - Validate membership locally: a well-formed id goes to the server and the
 *   server's answer is surfaced as returned, never retried against a lower
 *   class and never rewritten into a local not-found.
 */

import { basename } from "node:path";
import { describeRejectedValue } from "../../core-dist/redact.js";
import { findBindingKey, readBindingFile, updateBindingFile } from "../../core-dist/binding-file.js";
import {
  clearActiveOrgId,
  getActiveOrgId,
  setActiveOrgId,
} from "../../core-dist/profile-state.js";
import { getActiveProjectId, getProject, updateProject } from "../../core-dist/keystore.js";
import { LocalError, type NextAction } from "../errors.js";
import type { Client } from "../kernel.js";
import { Orgs } from "../namespaces/org.js";
import { Rooms } from "../namespaces/rooms.js";
import { Projects } from "../namespaces/projects.js";
import { localAction } from "./local-actions.js";

export const ORG_ENV = "RUN402_ORG";
export const ROOM_ENV = "RUN402_ROOM";
export const PROJECT_ENV = "RUN402_PROJECT_ID";

/** `org_id` is a UUID at every API boundary. */
export const ORG_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const CONTEXT = "resolving the organization";

export type OrgSource = "flag" | "env" | "binding" | "vault_pin" | "profile";

export interface ResolvedOrg {
  orgId: string;
  source: OrgSource;
  sourceDetail: string;
}

export interface ResolveOrgInput {
  /** The org named directly (the `--org` flag). */
  org?: string | null;
  /** A project named directly (the `--project` flag); its owning org decides. */
  project?: string | null;
}

export interface ResolveOrgOptions {
  env?: Record<string, string | undefined>;
  /** Directory the binding walk starts from. Default `process.cwd()`. */
  cwd?: string;
  /** Return null instead of throwing `ORG_REQUIRED` when nothing supplies an org. */
  optional?: boolean;
  /** Skip the env-vs-binding `AMBIGUOUS_ORG` error (surfaces that must stay usable while ambiguous). */
  allowConflict?: boolean;
}

export interface OrgProvenance {
  org_id: string | null;
  org_source: OrgSource | null;
  org_source_detail: string | null;
}

export interface CurrentOrgResult extends OrgProvenance {
  selected_org_id: string | null;
}

export interface OrgBindResult {
  org_id: string;
  room_key: string | null;
  org_source: "flag" | "sole_membership";
  file: ".run402.json";
  path: string;
  bound: true;
  safe_to_commit: true;
  note: string;
  binding: Record<string, unknown> | null;
}

export interface OrgUnbindResult {
  file: ".run402.json";
  unbound: boolean;
  removed: boolean;
  binding: Record<string, unknown> | null;
}

const trimmed = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function listOrgsAction(): NextAction {
  return localAction("edit_request", {
    command: "run402 orgs list",
    why: "List the organizations this wallet belongs to.",
  });
}

/** The recovery actions an `ORG_REQUIRED` refusal carries: every way to supply an org. */
export function orgRequiredActions(): NextAction[] {
  return [
    localAction("edit_request", {
      command: "run402 orgs use <org_id>",
      why: "Select a current organization for this wallet profile.",
    }),
    listOrgsAction(),
    localAction("edit_request", {
      command: "run402 <command> --org <org_id>",
      why: "Name the organization on this one call.",
    }),
    localAction("edit_request", {
      command: "export RUN402_ORG=<org_id>",
      why: "Name the organization for every call in this shell (harness wiring).",
    }),
    localAction("edit_request", {
      command: `echo '{"org":"<org_id>"}' > .run402.json`,
      why: "Bind this checkout to an organization so every agent in it inherits the same one.",
    }),
    localAction("edit_request", {
      command: "run402 projects use <project_id>",
      why: "Select a project; its owning organization becomes the current one.",
    }),
  ];
}

/**
 * Shape-validate an organization id from a local source. Never checks
 * membership. A rejected value may be a pasted secret, so it is redacted.
 */
export function assertOrgIdShape(orgId: string, origin: string): string {
  if (ORG_ID_RE.test(orgId)) return orgId;
  throw new LocalError(`Invalid organization id ${JSON.stringify(describeRejectedValue(orgId))} (from ${origin}).`, CONTEXT, {
    code: "BAD_ORG_ID",
    hint: "An org_id is a UUID. Run 'run402 orgs list' to see the organizations you belong to.",
    details: { org_id: describeRejectedValue(orgId), origin },
    next_actions: [listOrgsAction()],
  });
}

/** The `ORG_REQUIRED` refusal, optionally naming a rejected positional. */
export function orgRequiredError(opts: { rejectedPositional?: string; positionalHint?: boolean } = {}): LocalError {
  const rejected = opts.rejectedPositional;
  return new LocalError(
    typeof rejected === "string"
      ? `No organization specified and no current organization set (${JSON.stringify(rejected)} is not an org_id — an org_id is a UUID).`
      : "No organization specified and no current organization set.",
    CONTEXT,
    {
      code: "ORG_REQUIRED",
      hint: opts.positionalHint
        ? `Pass --org <org_id> (or a leading <org_id> positional), set ${ORG_ENV}, bind this directory in .run402.json, or run: run402 orgs use <org_id>`
        : `Pass --org <org_id>, set ${ORG_ENV}, bind this directory in .run402.json, or run: run402 orgs use <org_id>`,
      ...(typeof rejected === "string" ? { details: { rejected_positional: rejected } } : {}),
      next_actions: orgRequiredActions(),
    },
  );
}

/** The org half of `RUN402_ROOM=<org_id>/<room_key>`, or null. */
function orgFromRoomEnv(env: Record<string, string | undefined>): string | null {
  const raw = trimmed(env[ROOM_ENV]);
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return raw.slice(0, slash);
}

/**
 * `r402.orgId` from `cwd`'s local git config: a vault checkout's pin first,
 * then the bare org/room pin a room-only `rooms join` writes. Best-effort:
 * no repository, no pin, or a malformed value is simply null.
 */
async function readVaultPinnedOrgId(cwd: string): Promise<string | null> {
  try {
    const { readPinnedVaultRepo, readPinnedRoomBinding } = await import("./vault-address.js");
    const pinned = await readPinnedVaultRepo(cwd);
    const orgId = trimmed(pinned?.org_id);
    if (orgId && ORG_ID_RE.test(orgId)) return orgId;
    const bare = await readPinnedRoomBinding(cwd);
    const bareOrgId = trimmed(bare?.org_id);
    return bareOrgId && ORG_ID_RE.test(bareOrgId) ? bareOrgId : null;
  } catch {
    return null;
  }
}

/** A directory name coerced into a legal room key, or null. */
function roomKeyFromDir(dir: string): string | null {
  const base = basename(dir);
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+/, "").slice(0, 64);
  return /^[a-z0-9]/.test(slug) ? slug : null;
}

/** Provenance triple for command output: bounded, never a resolution trace. */
export function orgProvenance(resolved: ResolvedOrg | null): OrgProvenance {
  return resolved
    ? { org_id: resolved.orgId, org_source: resolved.source, org_source_detail: resolved.sourceDetail }
    : { org_id: null, org_source: null, org_source_detail: null };
}

/**
 * `r.orgs` on the Node entry: the isomorphic org collection and identity
 * verbs plus the local organization context.
 */
export class NodeOrgs extends Orgs {
  readonly #client: Client;
  readonly #rooms: Pick<Rooms, "forProject">;
  readonly #projects: Pick<Projects, "list">;

  /**
   * @param namespaces the reads the resolver makes (a project's org, the
   *   project listing); default to fresh namespaces on `client`.
   */
  constructor(client: Client, namespaces: { rooms?: Pick<Rooms, "forProject">; projects?: Pick<Projects, "list"> } = {}) {
    super(client);
    this.#client = client;
    this.#rooms = namespaces.rooms ?? new Rooms(client);
    this.#projects = namespaces.projects ?? new Projects(client);
  }

  /**
   * A project's owning org: the local key cache when it carries one, else one
   * read. An explicitly named project (`required`) that cannot be resolved
   * throws — falling to a lower class would act on a different org than the
   * caller asked for; an implicit one returns null.
   */
  async #orgOfProject(projectId: string, required: boolean): Promise<string | null> {
    const cached = ((await this.#client.getProjectCredentials(projectId)) as { org_id?: unknown } | null)?.org_id;
    if (typeof cached === "string" && cached.length > 0) return cached;
    try {
      return (await this.#rooms.forProject(projectId)).orgId;
    } catch (err) {
      if (!required) return null;
      throw err;
    }
  }

  /**
   * The one resolver. Returns the org with its provenance, or null when
   * `optional` and nothing supplies one; throws `BAD_ORG_ID`, `AMBIGUOUS_ORG`,
   * or `ORG_REQUIRED` (each with its recovery actions) otherwise.
   */
  async resolve(input: ResolveOrgInput = {}, opts: ResolveOrgOptions = {}): Promise<ResolvedOrg | null> {
    const { env = process.env, cwd = process.cwd(), optional = false, allowConflict = false } = opts;

    // Class 1: flag.
    const orgFlag = trimmed(input.org);
    if (orgFlag) return { orgId: assertOrgIdShape(orgFlag, "--org"), source: "flag", sourceDetail: "--org" };
    const projectFlag = trimmed(input.project);
    if (projectFlag) {
      const orgId = await this.#orgOfProject(projectFlag, true);
      if (orgId) return { orgId, source: "flag", sourceDetail: "--project" };
    }

    // Classes 2 and 3: environment vs binding (the conflict pair).
    const bindingHit = findBindingKey(cwd, "org");
    const bindingOrg = bindingHit ? assertOrgIdShape(bindingHit.value, bindingHit.file) : null;

    const envDirect = trimmed(env[ORG_ENV]);
    const envRoomOrg = envDirect ? null : orgFromRoomEnv(env);
    const envProject = envDirect || envRoomOrg ? null : trimmed(env[PROJECT_ENV]);

    let envOrg: string | null = null;
    let envDetail: string | null = null;
    if (envDirect) {
      envOrg = assertOrgIdShape(envDirect, ORG_ENV);
      envDetail = ORG_ENV;
    } else if (envRoomOrg) {
      envOrg = assertOrgIdShape(envRoomOrg, ROOM_ENV);
      envDetail = ROOM_ENV;
    } else if (envProject && bindingOrg) {
      // Only worth a lookup when a binding exists to disagree with.
      envOrg = await this.#orgOfProject(envProject, false);
      envDetail = PROJECT_ENV;
    }

    if (envOrg && bindingOrg && envOrg !== bindingOrg && !allowConflict) {
      // A binding deliberately declared by a checkout outranks the profile
      // selection silently; an ambient env var disagreeing with a committed
      // file is the surprise worth stopping on.
      throw new LocalError(`Ambiguous organization: ${envDetail}=${envOrg} but ${bindingHit!.file} binds ${bindingOrg}.`, CONTEXT, {
        code: "AMBIGUOUS_ORG",
        hint: `Resolve with one of: pass --org <org_id>, unset ${envDetail}, or edit the binding file.`,
        details: {
          candidates: [
            { org_id: envOrg, source: "env", source_detail: envDetail },
            { org_id: bindingOrg, source: "binding", source_detail: bindingHit!.file },
          ],
        },
        next_actions: [
          localAction("edit_request", {
            command: "run402 <command> --org <org_id>",
            why: "The flag resolves the conflict for this call.",
          }),
        ],
      });
    }

    if (envOrg) return { orgId: envOrg, source: "env", sourceDetail: envDetail! };
    if (envProject) {
      const orgId = await this.#orgOfProject(envProject, false);
      if (orgId) return { orgId, source: "env", sourceDetail: PROJECT_ENV };
    }
    if (bindingOrg) return { orgId: bindingOrg, source: "binding", sourceDetail: bindingHit!.file };

    // Class 3.5: this checkout's vault pin.
    const pinnedOrg = await readVaultPinnedOrgId(cwd);
    if (pinnedOrg) return { orgId: pinnedOrg, source: "vault_pin", sourceDetail: "r402.orgId (local git config)" };

    // Class 4: profile state.
    const selected = trimmed(getActiveOrgId());
    if (selected) return { orgId: assertOrgIdShape(selected, "orgs use"), source: "profile", sourceDetail: "orgs use" };
    const activeProject = trimmed(getActiveProjectId());
    if (activeProject) {
      const orgId = await this.#orgOfProject(activeProject, false);
      if (orgId) return { orgId, source: "profile", sourceDetail: "projects use" };
    }

    if (optional) return null;
    throw orgRequiredError();
  }

  /** Select the current organization for the active wallet profile (`orgs use`). */
  async use(orgId: string): Promise<{ org_id: string; selected: true; scope: "wallet_profile" }> {
    setActiveOrgId(assertOrgIdShape(orgId, "orgs use"));
    return { org_id: orgId, selected: true, scope: "wallet_profile" };
  }

  /**
   * The organization this directory and profile resolve to, with provenance,
   * beside the profile's own selection. An empty selection is an explicit
   * null state. Never fails on ambiguity: the command that reports the
   * selection stays usable while it is ambiguous.
   */
  async current(opts: Pick<ResolveOrgOptions, "env" | "cwd"> = {}): Promise<CurrentOrgResult> {
    const resolved = await this.resolve({}, { ...opts, optional: true, allowConflict: true });
    return { ...orgProvenance(resolved), selected_org_id: this.selected() };
  }

  /** The profile's selected organization, without running the chain. */
  selected(): string | null {
    return trimmed(getActiveOrgId());
  }

  /** Clear the profile's selected organization. */
  async clear(): Promise<{ org_id: null; selected: false; previous_org_id: string | null }> {
    const previous = this.selected();
    clearActiveOrgId();
    return { org_id: null, selected: false, previous_org_id: previous ?? null };
  }

  /**
   * Write this checkout's org (and room) into `.run402.json`. With no org, the
   * caller's sole membership is used and written down: an explicit, recorded
   * act, unlike the chain, which never infers. Two or more memberships refuse.
   */
  async bind(orgId?: string | null, opts: { room?: string | null; cwd?: string } = {}): Promise<OrgBindResult> {
    const cwd = opts.cwd ?? process.cwd();
    let chosen = orgId || null;
    let picked: "flag" | "sole_membership" = "flag";
    if (!chosen) {
      const rows = await this.list();
      if (rows.length === 0) {
        throw new LocalError("This wallet is a member of no organization yet.", "binding the organization", {
          code: "NO_ORGS",
          hint: "Run 'run402 init' to provision one, or ask an owner to add you with 'run402 orgs members add'.",
          next_actions: [localAction("initialize_wallet", { command: "run402 init", why: "Provision this wallet's organization, then retry." })],
        });
      }
      if (rows.length > 1) {
        throw new LocalError(`This wallet belongs to ${rows.length} organizations — name the one to bind.`, "binding the organization", {
          code: "AMBIGUOUS_ORG",
          hint: "run402 orgs bind --org <org_id>",
          details: { orgs: rows.map((o) => ({ org_id: o.org_id, display_name: o.display_name ?? null, role: o.role ?? null })) },
          next_actions: [localAction("edit_request", { command: "run402 orgs bind --org <org_id>", why: "Name which organization this checkout coordinates in." })],
        });
      }
      chosen = rows[0]!.org_id;
      picked = "sole_membership";
    }
    const room = opts.room ?? roomKeyFromDir(cwd);
    const { contents, file } = updateBindingFile(cwd, {
      org: assertOrgIdShape(chosen, picked === "flag" ? "--org" : "orgs list"),
      ...(room ? { room } : {}),
    });
    return {
      org_id: chosen,
      room_key: room ?? null,
      org_source: picked,
      file: ".run402.json",
      path: file,
      bound: true,
      safe_to_commit: true,
      note: "Safe to commit — an org id is an identifier, not a credential; authorization stays server-side.",
      binding: contents,
    };
  }

  /** Remove the `org` and `room` keys from `./.run402.json`; the file goes when nothing else is left. */
  async unbind(opts: { cwd?: string } = {}): Promise<OrgUnbindResult> {
    const cwd = opts.cwd ?? process.cwd();
    const previous = readBindingFile(cwd);
    const { contents, removed } = updateBindingFile(cwd, { org: null, room: null });
    return {
      file: ".run402.json",
      unbound: previous.org !== undefined || previous.room !== undefined,
      removed,
      binding: contents,
    };
  }

  /**
   * Stamp a project's owning organization as the profile's selection
   * (`projects use` does this: a project determines its org unambiguously).
   * Best-effort: returns the org, or null, and never throws.
   */
  async selectFromProject(projectId: string): Promise<string | null> {
    try {
      const orgId = await this.#orgOfProject(projectId, false);
      if (orgId) {
        setActiveOrgId(orgId);
        return orgId;
      }
    } catch {
      /* best-effort */
    }
    return null;
  }

  /**
   * The organization that OWNS a specific project, or null. Distinct from
   * {@link resolve} (which org a command is addressed at): an `--org` override
   * here would be a mis-binding. Remembered in the local project entry after
   * the first lookup, so the vault scaffold adds no network read on a
   * returning machine; an exact id match is required.
   */
  async owningOrgOf(projectId: string): Promise<string | null> {
    const cached = (getProject(projectId) as { org_id?: unknown } | undefined)?.org_id;
    if (typeof cached === "string" && cached.length > 0) return cached;
    try {
      const listed = await this.#projects.list();
      const rows = Array.isArray(listed?.projects) ? listed.projects : [];
      const row = rows.find((p: { id?: string; project_id?: string }) => (p?.id ?? p?.project_id) === projectId) as { org_id?: string } | undefined;
      const orgId = row?.org_id;
      if (typeof orgId !== "string" || orgId.length === 0) return null;
      try {
        updateProject(projectId, { org_id: orgId });
      } catch {
        /* caching is an optimization */
      }
      return orgId;
    } catch {
      return null;
    }
  }
}
