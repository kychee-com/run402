/**
 * Types for the `appRepos` namespace: plain git repositories owned by a
 * project and written by its app (`/projects/v1/:project_id/app-repos`).
 *
 * An app repo is NOT a KyGit vault: it is unencrypted, the platform reads its
 * files to serve them, and it has one linear branch, `main`. The encrypted
 * remote for source is `r.repos`. Every project has a `default` app repo that
 * needs no creation; until its first commit it reads as an empty repository
 * (`head: null`, no files, an empty log).
 */

/** A git identity as the history records it. */
export interface AppRepoPerson {
  name: string;
  email: string;
}

/** One app repo (`GET /projects/v1/:project_id/app-repos/:repo_name`). */
export interface AppRepo {
  /** `default`, or a name matching `^[a-z0-9][a-z0-9._-]{0,63}$` (never ending in `.git`). */
  repo_name: string;
  /** The commit `main` points at; `null` for an empty repo. */
  head: string | null;
  /** The head commit's per-repo sequence number; `null` for an empty repo. */
  seq: number | null;
  commit_count: number;
  /** Bytes of the objects this repo references (counted toward the organization's pooled storage). */
  size_bytes: number;
  /** `size_bytes` as a decimal label, e.g. `"1.2 MB"`. */
  size: string;
  /** `https://…/projects/v1/:project_id/app-repos/:repo_name.git`; holds no credential. Clone it with `run402 app-repos clone`. */
  clone_url: string;
  /** `null` for the `default` repo before its first commit. */
  created_at: string | null;
  updated_at: string | null;
}

/** `GET /projects/v1/:project_id/app-repos`: `default` is always listed. */
export interface AppRepoList {
  app_repos: AppRepo[];
}

/** `POST /projects/v1/:project_id/app-repos`. */
export interface AppRepoCreateOptions {
  repo_name: string;
  /** Another repo of the same project to start from: its head and history are copied, its objects shared (no bytes copied). */
  from?: string;
}

/** `DELETE …/app-repos/:repo_name?confirm=<repo_name>`. */
export interface AppRepoDeleteOptions {
  /** Must equal the repo name. */
  confirm: string;
}

export interface AppRepoDeleteResult {
  deleted: true;
  repo_name: string;
}

/** One commit on `main`, as the log records it. */
export interface AppRepoCommit {
  commit: string;
  /** First parent; `null` for the first commit. */
  parent: string | null;
  seq: number;
  author: AppRepoPerson;
  committer: AppRepoPerson;
  message: string;
  committed_at: string;
  /** Changed paths relative to the first parent, capped at 100. */
  paths: string[];
  /** Exact number of changed paths. */
  paths_total: number;
  /** The end user the gateway verified for an app commit (`Run402-Actor` trailer); `null` otherwise. */
  actor_user_id: string | null;
}

export interface AppRepoLogOptions {
  /** Only commits that changed this path (a file, or a directory prefix). */
  path?: string;
  /** `next_cursor` from the previous page. */
  cursor?: string;
  /** 1–100, default 50. */
  limit?: number;
}

/** `GET …/:repo_name/commits`: newest first. */
export interface AppRepoLogPage {
  commits: AppRepoCommit[];
  head: string | null;
  has_more: boolean;
  next_cursor: string | null;
}

export interface AppRepoReadOptions {
  /** A commit id; omitted reads the head. */
  at?: string;
}

/** A file read with `readFile`. */
export interface AppRepoFile {
  repo_name: string;
  path: string;
  /** The commit read (`X-Run402-Commit`). */
  commit: string | null;
  /** The blob's git object id (`ETag`). */
  oid: string | null;
  content_type: string | null;
  size_bytes: number;
  bytes: Uint8Array;
  /** `bytes` decoded as UTF-8, or `null` when they are not valid UTF-8. */
  text: string | null;
}

export interface AppRepoTreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  /** File size in bytes; `null` for a directory. */
  size: number | null;
  oid: string;
}

/** `GET …/:repo_name/tree[/<path>]`. */
export interface AppRepoTree {
  /** `null` for an empty repo (and then `entries` is empty). */
  commit: string | null;
  path: string;
  entries: AppRepoTreeEntry[];
}

export interface AppRepoDiffChange {
  path: string;
  status: "added" | "modified" | "deleted";
  old_oid: string | null;
  new_oid: string | null;
}

/** `GET …/:repo_name/diff?from=&to=`. */
export interface AppRepoDiff {
  from: string;
  to: string;
  changes: AppRepoDiffChange[];
}

/**
 * One path's new content on the wire: UTF-8 text, base64 bytes, or a JSON
 * value the gateway writes canonically (object keys sorted, two-space
 * indent, a trailing newline).
 */
export type AppRepoFileContent = { text: string } | { base64: string } | { json: unknown };

/**
 * Path → content. A `string` is shorthand for `{ text }`, a `Uint8Array` for
 * `{ base64 }`, and `null` deletes the path. Paths have no leading `/`, no
 * `.`, `..` or `.git` segment; at most 1,000 entries; each file at most
 * 4 MiB (`APP_REPO_FILE_TOO_LARGE`: put media in `assets.put` and commit a
 * reference).
 */
export type AppRepoCommitFiles = Record<string, AppRepoFileContent | string | Uint8Array | null>;

/** `POST …/:repo_name/commits`. */
export interface AppRepoCommitOptions {
  files: AppRepoCommitFiles;
  /** Default `Update <path>` for one path, `Update <n> files` otherwise. */
  message?: string;
  /** Who the commit names as author; the committer is always the app. */
  author?: AppRepoPerson;
  /** Land only if this is still the head (`409 APP_REPO_CONFLICT` otherwise). */
  parent?: string;
  /**
   * The commit you read from (default: the head). Without `parent`, the
   * commit lands on a newer head only when none of its paths changed since
   * `base`; otherwise `409 APP_REPO_CONFLICT` with `details.conflicting_paths`.
   */
  base?: string;
}

/** `POST …/:repo_name/reverts`. */
export interface AppRepoRevertOptions {
  /** Default `Revert "<subject>"`, with the trailer `This reverts commit <commit>.` */
  message?: string;
}

/** A commit that changed something (`201`). */
export interface AppRepoCommitted {
  committed: true;
  commit: string;
  parent: string | null;
  head: string;
  seq: number;
  paths: string[];
  author: AppRepoPerson;
}

/** A commit that changed nothing (`200`): no commit was created. */
export interface AppRepoNotCommitted {
  committed: false;
  head: string | null;
}

export type AppRepoCommitResult = AppRepoCommitted | AppRepoNotCommitted;
