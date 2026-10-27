/**
 * `appRepos` namespace — plain git repositories owned by a project and
 * written by its app (`/projects/v1/:project_id/app-repos`).
 *
 * An app repo is NOT a KyGit vault (`r.repos`): it is unencrypted, one linear
 * `main`, stored in the project's content-addressed storage and billed as
 * project storage. Every project has a `default` repo that needs no creation;
 * other repos are created explicitly and never by a read, commit, or push.
 * Functions read and commit through `repo` / `repos` from `@run402/functions`;
 * people and agents also clone and push with plain git (`run402 app-repos
 * clone`). The SDK has no clone method: cloning writes a working tree and
 * hands git a credential, so it is CLI-only.
 *
 * Exposed unscoped (`r.appRepos.list(projectId)`) and project-scoped
 * (`r.project(id).appRepos.list()`). Every call sends your principal (grant
 * key, wallet, or sign-in session) when the credential provider has one,
 * otherwise the project's locally cached service key. Reads need
 * `project.app_repos.read` (viewer); create, delete, commit, and revert need
 * `project.app_repos.write` (developer, or a grant with `deploy`).
 */

import type { Client } from "../kernel.js";
import { ApiError, LocalError, NetworkError, NotAuthorizedError, PaymentRequired, Unauthorized } from "../errors.js";
import type {
  AppRepo,
  AppRepoCommitFiles,
  AppRepoCommitOptions,
  AppRepoCommitResult,
  AppRepoCreateOptions,
  AppRepoDeleteOptions,
  AppRepoDeleteResult,
  AppRepoDiff,
  AppRepoFile,
  AppRepoFileContent,
  AppRepoList,
  AppRepoLogOptions,
  AppRepoLogPage,
  AppRepoReadOptions,
  AppRepoRevertOptions,
  AppRepoTree,
} from "./app-repos.types.js";

function collectionPath(projectId: string): string {
  return `/projects/v1/${encodeURIComponent(projectId)}/app-repos`;
}

function repoPath(projectId: string, repoName: string): string {
  return `${collectionPath(projectId)}/${encodeURIComponent(repoName)}`;
}

/** Encode a repo path segment by segment, keeping its `/` separators. */
function encodeRepoFilePath(path: string): string {
  return path.split("/").filter((s) => s.length > 0).map(encodeURIComponent).join("/");
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

function requireArg(value: unknown, name: string, context: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalError(`appRepos: ${name} is required`, context);
  }
}

/** Diagnostic auth metadata. App-repo writes are not a write-approval capability, so none is named. */
function authMeta(method: string, projectId: string) {
  return { method: `appRepos.${method}`, target: { project_id: projectId } };
}

function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } }; btoa?: (s: string) => string };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return g.btoa!(s);
}

/** Turn the SDK's shorthand (`string`, `Uint8Array`) into the wire shape. */
function wireFiles(files: AppRepoCommitFiles): Record<string, AppRepoFileContent | null> {
  const out: Record<string, AppRepoFileContent | null> = {};
  for (const [path, value] of Object.entries(files)) {
    if (value === null) out[path] = null;
    else if (typeof value === "string") out[path] = { text: value };
    else if (value instanceof Uint8Array) out[path] = { base64: bytesToBase64(value) };
    else if (value && typeof value === "object" && ("text" in value || "base64" in value || "json" in value)) out[path] = value;
    else {
      throw new LocalError(
        `appRepos.commit: files["${path}"] must be a string, a Uint8Array, null, or one of { text }, { base64 }, { json }`,
        "committing to app repo",
      );
    }
  }
  return out;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function displayMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
    if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
  }
  return fallback;
}

function envelopeCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

async function readErrorBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? await res.json().catch(() => null) : await res.text().catch(() => "");
}

function throwFileError(status: number, body: unknown, context: string): never {
  const message = displayMessage(body, "Reading app repo file failed");
  if (status === 402) throw new PaymentRequired(`${message} while ${context}`, status, body, context);
  if (status === 403 && envelopeCode(body) === "NOT_AUTHORIZED") {
    throw new NotAuthorizedError(`${message} while ${context} (HTTP ${status})`, status, body, context);
  }
  if (status === 401 || status === 403) throw new Unauthorized(`${message} while ${context} (HTTP ${status})`, status, body, context);
  throw new ApiError(`${message} while ${context} (HTTP ${status})`, status, body, context);
}

export class AppRepos {
  constructor(private readonly client: Client) {}

  /** Every app repo of the project; `default` is always listed (`GET …/app-repos`). */
  async list(projectId: string): Promise<AppRepoList> {
    requireArg(projectId, "projectId", "listing app repos");
    return this.client.request<AppRepoList>(collectionPath(projectId), {
      authMeta: authMeta("list", projectId),
      projectKeyFallback: projectId,
      context: "listing app repos",
    });
  }

  /**
   * Create a repo, optionally from another repo of the same project (its head
   * and history are copied and its objects shared). A taken name is
   * `409 APP_REPO_EXISTS`.
   */
  async create(projectId: string, opts: AppRepoCreateOptions): Promise<AppRepo> {
    requireArg(projectId, "projectId", "creating app repo");
    requireArg(opts?.repo_name, "repo_name", "creating app repo");
    const body: Record<string, string> = { repo_name: opts.repo_name };
    if (opts.from !== undefined) body.from = opts.from;
    return this.client.request<AppRepo>(collectionPath(projectId), {
      method: "POST",
      body,
      authMeta: authMeta("create", projectId),
      projectKeyFallback: projectId,
      context: "creating app repo",
    });
  }

  /** One repo, with its head and `clone_url` (`GET …/app-repos/:repo_name`). */
  async get(projectId: string, repoName: string): Promise<AppRepo> {
    requireArg(projectId, "projectId", "getting app repo");
    requireArg(repoName, "repoName", "getting app repo");
    return this.client.request<AppRepo>(repoPath(projectId, repoName), {
      authMeta: authMeta("get", projectId),
      projectKeyFallback: projectId,
      context: "getting app repo",
    });
  }

  /**
   * Delete a repo. `confirm` must equal the repo name; `default` cannot be
   * deleted (`403 APP_REPO_DEFAULT_UNDELETABLE`). Its objects become
   * collectable once no other repo of the project references them.
   */
  async delete(projectId: string, repoName: string, opts: AppRepoDeleteOptions): Promise<AppRepoDeleteResult> {
    const context = "deleting app repo";
    requireArg(projectId, "projectId", context);
    requireArg(repoName, "repoName", context);
    if (opts?.confirm !== repoName) {
      throw new LocalError(
        `appRepos.delete: pass { confirm: "${repoName}" } to delete app repo ${repoName}`,
        context,
        { code: "CONFIRMATION_REQUIRED", details: { repo_name: repoName } },
      );
    }
    return this.client.request<AppRepoDeleteResult>(withQuery(repoPath(projectId, repoName), { confirm: opts.confirm }), {
      method: "DELETE",
      authMeta: authMeta("delete", projectId),
      projectKeyFallback: projectId,
      context,
    });
  }

  /** The commits on `main`, newest first, optionally only those that changed `path`. */
  async log(projectId: string, repoName: string, opts: AppRepoLogOptions = {}): Promise<AppRepoLogPage> {
    requireArg(projectId, "projectId", "reading app repo log");
    requireArg(repoName, "repoName", "reading app repo log");
    const path = withQuery(`${repoPath(projectId, repoName)}/commits`, { path: opts.path, cursor: opts.cursor, limit: opts.limit });
    return this.client.request<AppRepoLogPage>(path, {
      authMeta: authMeta("log", projectId),
      projectKeyFallback: projectId,
      context: "reading app repo log",
    });
  }

  /**
   * One file's bytes at the head, or at `opts.at`. Returns `null` when the
   * file is absent (`APP_REPO_PATH_NOT_FOUND`), including in an empty repo;
   * any other failure throws.
   */
  async readFile(projectId: string, repoName: string, path: string, opts: AppRepoReadOptions = {}): Promise<AppRepoFile | null> {
    const context = "reading app repo file";
    requireArg(projectId, "projectId", context);
    requireArg(repoName, "repoName", context);
    requireArg(path, "path", context);
    const apiPath = withQuery(`${repoPath(projectId, repoName)}/files/${encodeRepoFilePath(path)}`, { at: opts.at });
    const headers: Record<string, string> = {};
    const auth = await this.client.credentials.getAuth(apiPath, authMeta("readFile", projectId));
    if (auth) Object.assign(headers, auth);
    else {
      const keys = await this.client.getProjectCredentials(projectId);
      if (keys?.service_key) headers.Authorization = `Bearer ${keys.service_key}`;
    }
    let res: Response;
    try {
      res = await this.client.fetch(`${this.client.apiBase}${apiPath}`, { headers });
    } catch (err) {
      throw new NetworkError(`Network error while ${context}: ${(err as Error).message}`, err, context);
    }
    if (!res.ok) {
      const body = await readErrorBody(res);
      if (res.status === 404 && envelopeCode(body) === "APP_REPO_PATH_NOT_FOUND") return null;
      throwFileError(res.status, body, context);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const etag = res.headers.get("etag");
    return {
      repo_name: repoName,
      path,
      commit: res.headers.get("x-run402-commit"),
      oid: etag ? etag.replace(/^W\//, "").replace(/^"|"$/g, "") : null,
      content_type: res.headers.get("content-type"),
      size_bytes: bytes.byteLength,
      bytes,
      text: decodeUtf8(bytes),
    };
  }

  /** A directory listing at the head, or at `opts.at`; the repo root when `path` is omitted. */
  async tree(projectId: string, repoName: string, path?: string, opts: AppRepoReadOptions = {}): Promise<AppRepoTree> {
    requireArg(projectId, "projectId", "listing app repo tree");
    requireArg(repoName, "repoName", "listing app repo tree");
    const sub = path ? encodeRepoFilePath(path) : "";
    const apiPath = withQuery(`${repoPath(projectId, repoName)}/tree${sub ? `/${sub}` : ""}`, { at: opts.at });
    return this.client.request<AppRepoTree>(apiPath, {
      authMeta: authMeta("tree", projectId),
      projectKeyFallback: projectId,
      context: "listing app repo tree",
    });
  }

  /** The paths that changed between two commits. */
  async diff(projectId: string, repoName: string, from: string, to: string): Promise<AppRepoDiff> {
    requireArg(projectId, "projectId", "diffing app repo");
    requireArg(repoName, "repoName", "diffing app repo");
    requireArg(from, "from", "diffing app repo");
    requireArg(to, "to", "diffing app repo");
    return this.client.request<AppRepoDiff>(withQuery(`${repoPath(projectId, repoName)}/diff`, { from, to }), {
      authMeta: authMeta("diff", projectId),
      projectKeyFallback: projectId,
      context: "diffing app repo",
    });
  }

  /**
   * Commit files to `main`. A `string` is UTF-8 text, a `Uint8Array` bytes,
   * `null` deletes, and `{ json }` is written canonically. Without `parent`,
   * the commit lands on a newer head when none of its paths changed since
   * `base`; otherwise `409 APP_REPO_CONFLICT` names `conflicting_paths`. A
   * commit that changes nothing returns `{ committed: false, head }`.
   */
  async commit(projectId: string, repoName: string, opts: AppRepoCommitOptions): Promise<AppRepoCommitResult> {
    const context = "committing to app repo";
    requireArg(projectId, "projectId", context);
    requireArg(repoName, "repoName", context);
    if (!opts || typeof opts.files !== "object" || opts.files === null) {
      throw new LocalError("appRepos.commit: files is required (a map from path to content)", context);
    }
    const body: Record<string, unknown> = { files: wireFiles(opts.files) };
    if (opts.message !== undefined) body.message = opts.message;
    if (opts.author !== undefined) body.author = opts.author;
    if (opts.parent !== undefined) body.parent = opts.parent;
    if (opts.base !== undefined) body.base = opts.base;
    return this.client.request<AppRepoCommitResult>(`${repoPath(projectId, repoName)}/commits`, {
      method: "POST",
      body,
      authMeta: authMeta("commit", projectId),
      projectKeyFallback: projectId,
      context,
    });
  }

  /**
   * Commit the inverse of `commit`'s changes (undo is a new commit; history is
   * never rewritten). It lands on the head unless a path it restores changed
   * after `commit` (`409 APP_REPO_CONFLICT`).
   */
  async revert(projectId: string, repoName: string, commit: string, opts: AppRepoRevertOptions = {}): Promise<AppRepoCommitResult> {
    const context = "reverting app repo commit";
    requireArg(projectId, "projectId", context);
    requireArg(repoName, "repoName", context);
    requireArg(commit, "commit", context);
    const body: Record<string, unknown> = { commit };
    if (opts.message !== undefined) body.message = opts.message;
    return this.client.request<AppRepoCommitResult>(`${repoPath(projectId, repoName)}/reverts`, {
      method: "POST",
      body,
      authMeta: authMeta("revert", projectId),
      projectKeyFallback: projectId,
      context,
    });
  }
}
