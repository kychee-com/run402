---
title: App repos
description: Keep content your app's users edit in plain git repositories the project owns, commit from functions with the end user as author, clone and push with git, and serve the latest commit through a route with no deploy.
---

An app repo is a plain git repository owned by a project and written by its app. A function commits a file and the next request reads it; the commit names the signed-in end user as its author; the owner and their agents clone it and push with ordinary git; a route serves its latest commit with no deploy. Use it for content that people edit through the app: a family tree, a wiki, a club's pages, per-user documents.

**An app repo is not encrypted and is not a KyGit vault.** Run402 reads its files to serve them and to answer reads, the same as assets. The encrypted, host-blind home for your app's source is `run402 repos` (a vault); keep source there and the content your app writes in an app repo.

```bash
run402 app-repos list --project prj_example
run402 app-repos log --path people/p-x.json --project prj_example
run402 app-repos cat site.json --project prj_example
run402 app-repos clone default ./content --project prj_example
```

Use the [app-repos command reference](/cli/functions/) for every flag and output field, and the [SDK namespace](/sdk/resources/) for the typed calls (`r.appRepos.*`). App repos need Run402 Cloud: on self-hosted Run402 Core the function helpers throw `APP_REPOS_UNSUPPORTED`.

## The default repo and named repos

Every project has a repo named `default`. It needs no creation: until its first commit it reads as an empty repository (no files, an empty log, `head: null`), never as an error.

Create any other repo explicitly. A name is lowercase letters, digits, `.`, `_` and `-` (at most 64 characters, starting with a letter or digit, not ending in `.git`). A repo created `from` another repo of the project starts with its files and history and shares its objects, so no bytes are copied:

```bash
run402 app-repos create template --project prj_example
run402 app-repos create user-42 --from template --project prj_example
run402 app-repos delete user-42 --confirm user-42 --project prj_example
```

A read, a commit or a push to a repo that does not exist fails with `APP_REPO_NOT_FOUND` and a `create_app_repo` next action; it never creates the repo, so a typo in a name fails loudly. A taken name is `409 APP_REPO_EXISTS`. `default` cannot be deleted (`APP_REPO_DEFAULT_UNDELETABLE`). There is no limit on how many repos a project holds; their bytes count toward the organization's pooled storage, like assets.

## Read and commit from a function

`@run402/functions` exports `repo` (the `default` repo) and `repos` (`open(name)`, `create(name, { from? })`, `list()`, `delete(name, { confirm })`):

```ts
import { auth, repo } from "@run402/functions";

export default async (req: Request) => {
  if (req.method === "GET") {
    const people = (await repo.readJson("people/index.json")) ?? [];
    return Response.json(people);
  }
  await auth.requireUser();
  const person = await req.json();
  const result = await repo.commit(
    { [`people/${person.id}.json`]: person },
    { message: `Update ${person.name}` },
  );
  return Response.json(result); // { committed: true, commit, parent, head, seq, paths, author }
};
```

- Reads: `read(path)` (a string, or `null` when the file is absent), `readBytes(path)`, `readJson(path)` (parsed, or `null`) and `list(dir?)` (`[{ name, path, type, size, oid }]`).
- Writes: `commit(files, { message?, author?, parent? })` takes a map from path to content: a string is UTF-8 text, a `Uint8Array` is bytes, `null` deletes the path, and any other JSON value is written in one canonical form (object keys sorted, two-space indent, a trailing newline). `revert(commit, { message? })` commits the inverse of a commit.
- History: `repo.log({ path?, limit?, cursor? })` and `repo.diff(from, to)`. Pin a read with `at(commit)`; `head()` names the commit this request reads.

**One request reads one commit, and reads its own writes.** The first read of a repo in a request pins its head; every later read in that request comes from the same commit, so a page never shows half of two edits. A successful commit moves the pin, so the request reads what it wrote. The next request reads the new head.

**Edits to different paths never conflict.** A commit is built on the commit the request read. If another commit landed in between, yours still lands on top of it as long as none of your paths changed; if one did, the commit fails with `409 APP_REPO_CONFLICT` and `details: { head, base, conflicting_paths }`, and nothing is written: re-read those paths and try again. Pass `parent` to land only if the head has not moved at all. A commit that changes nothing returns `{ committed: false, head }` and creates no commit.

**The end user is the author.** The committer of every commit a function makes is the app (`<project name> <project_id@app-repos.run402.com>`). The author is the signed-in end user of the request: their display name and a synthetic address `<user_id>@users.<project_id>.run402.com`, never their email, so a clone never leaks members' addresses. The gateway verifies the signed-in user and appends the trailer `Run402-Actor: <user_id>` to the message. Pass `author: { name, email }` to act for someone else; the verified trailer stays as it was. A commit with no signed-in user and no `author` names the app as author and has no trailer.

Errors are `R402AppRepoError` with the gateway's `code`, `status`, `details` and `next_actions`.

## Clone and push with git

```bash
run402 app-repos clone default ./content --project prj_example
cd content
# edit people/p-x.json
git commit -am "Fix a birth date"
git push
```

`run402 app-repos clone [<name>] [<dir>]` runs `git clone` against `https://api.run402.com/projects/v1/<project_id>/app-repos/<name>.git` with a credential helper, `run402 app-repos credential`, scoped to that URL. The helper hands git the project's service key from this machine's keystore (or `RUN402_GRANT_KEY` when it is set), so no secret is written into the remote URL or `.git/config`. The helper stays configured in the clone, so later `git pull` and `git push` keep working. Any git client can use the same URL with HTTP Basic auth whose password is the service key or a grant key for the project.

A push is live on the next read, with no deploy. `main` is the only branch: a push to any other ref, a ref deletion and a non-fast-forward push are refused (`git push --force` included), because history is never rewritten. Undo a commit with a revert, which is a new commit (`git revert <commit>` then `git push`, or `repo.revert(commit)` in a function). A push needs `project.app_repos.write` (developer, or a grant with `deploy`); a clone needs `project.app_repos.read` (viewer). Shallow and partial clones are not supported.

## Keep media in assets

Each file in an app repo is at most 4 MiB. A commit or push carrying a larger file fails with `422 APP_REPO_FILE_TOO_LARGE`, naming the path and the cap, and nothing is committed. Put photos, video and other media in assets and commit the reference:

```ts
import { assets, repo } from "@run402/functions";

const ref = await assets.put(`photos/${id}.jpg`, bytes);
await repo.commit({ [`people/${id}.json`]: { ...person, photo: ref.cdn_immutable_url } });
```

Git LFS is refused (`APP_REPO_LFS_UNSUPPORTED`) for the same reason.

## Serve the latest commit through a route

A route target `{ type: "repo", repo, path?, requireAuth?, requireRole? }` serves files from a repo's latest commit, resolved on every request, so an edit is live without a deploy:

```json
{
  "routes": {
    "replace": [
      { "pattern": "/data/*", "methods": ["GET", "HEAD"], "target": { "type": "repo", "repo": "default", "path": "public/" } },
      { "pattern": "/members/*", "target": { "type": "repo", "repo": "default", "path": "members/", "requireAuth": true } }
    ]
  }
}
```

With a prefix pattern such as `/data/*`, the part matched by `*` is joined to `path` (default: the repo root): `GET /data/people.json` serves `public/people.json`. With an exact pattern, `path` names the file. A repo target serves `GET` and `HEAD` only and cannot be priced. The response carries `Content-Type` from the extension, an `ETag` of the file's git object id, and `Cache-Control: public, max-age=0, must-revalidate` (`private` when the target is gated). A missing file, a directory, or an empty repo is a 404. `requireAuth` and `requireRole` behave exactly as on a function route, including the redirect to sign-in. A plan whose repo target names a repo that does not exist fails validation.

## Run a function on each commit

A function trigger `{ id, type: "app_repo", repo, paths?, run: { event_type } }` queues one durable function run for each commit to `repo` that changes a path starting with one of `paths` (every commit when `paths` is omitted), with the commit's event under `payload.event`:

```json
{
  "functions": {
    "replace": {
      "bundle": {
        "runtime": "node22",
        "source": { "path": "functions/bundle.ts" },
        "triggers": [{ "id": "bundle", "type": "app_repo", "repo": "default", "paths": ["people/"], "run": { "event_type": "content.changed" } }]
      }
    }
  }
}
```

A push that adds several commits queues one run per matching commit, and a commit touching only `stories/` starts none. Use it to rebuild a derived file (an index, a bundle) from the commit in `payload.event.commit`. Every advance of `main` also emits the project event `app_repo_committed` (`{ repo_name, ref, commit, parent, seq, author, actor_user_id, paths, paths_total }`), which `run402 events list` shows.

## What app repos leave out

- A fork of a published app does not copy its app repos, and says so in `fork_warnings` with `FORK_APP_REPOS_NOT_COPIED`.
- Project snapshots do not capture app repos, and every snapshot read says so with `excluded: ["app_repos"]`. Git history is their undo.
- Purging a project deletes its app repos.
