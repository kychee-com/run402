# Design — email-multi-mailbox-selector

## Context

The gateway allows up to 5 mailboxes per project. The SDK/MCP/CLI email surface resolves a single mailbox via `Email.resolveMailbox(projectId)` (cached `mailbox_id` → else `list[0]`) and treats every `create` 409 as "already has a mailbox." Both assumptions break under N mailboxes. This change adds an explicit `mailbox` selector and fixes the now-unsafe 409 recovery, keeping the single-mailbox path fully back-compatible.

## Decisions

### 1. `resolveMailbox(projectId, selector?)` is the one resolution point

```ts
private async resolveMailbox(
  projectId: string,
  selector?: string,            // mailbox id ("mbx_…") OR slug
): Promise<{ id: string; serviceKey: string }> {
  const project = await this.client.getProject(projectId);
  if (!project) throw new ProjectNotFound(projectId, "resolving mailbox");

  // id selector → use directly; gateway 403s on cross-project ids.
  if (selector && /^mbx_/.test(selector)) {
    return { id: selector, serviceKey: project.service_key };
  }

  const list = await this.listMailboxes(project.service_key);

  // slug selector → exact active-slug match.
  if (selector) {
    const hit = list.find((m) => m.slug === selector);
    if (!hit) {
      throw new ApiError(
        `No mailbox with slug "${selector}" in this project.`,
        404, null, "resolving mailbox",
      );
    }
    return { id: hit.mailbox_id, serviceKey: project.service_key };
  }

  // omitted → 0 error / 1 use / 2+ ambiguity error.
  if (list.length === 0) {
    throw new ApiError(
      "No mailbox found for this project. Use `create_mailbox` to create one first.",
      404, null, "resolving mailbox",
    );
  }
  if (list.length > 1) {
    const slugs = list.map((m) => m.slug).join(", ");
    throw new ApiError(
      `Project has ${list.length} mailboxes (${slugs}). Specify which via the `mailbox` parameter (slug or id).`,
      409, null, "resolving mailbox",
    );
  }
  const only = list[0]!;
  this.cacheMailbox(projectId, only);   // best-effort keystore refresh
  return { id: only.mailbox_id, serviceKey: project.service_key };
}
```

- **Why list on omitted instead of trusting the cache:** the cached `mailbox_id` can't tell us whether the project now has 1 or 3 mailboxes, and trusting it is exactly the silent-wrong-target bug. One extra `GET /mailboxes/v1` on the omitted path is cheap and correct. The id-selector path still skips the list.
- **Ambiguity is a 409** (conflict-class) carrying the slug list so an agent/human immediately sees the options.

### 2. Thread `mailbox` through the public methods (additive)

- `send(projectId, opts)` / `list(projectId, opts)` — add `mailbox?: string` to `SendEmailOptions` / `ListEmailsOptions`.
- `get(projectId, messageId, opts?: { mailbox?: string })` / `getRaw(...)` — additive trailing opts.
- `getMailbox(projectId, selector?)` — with a selector returns that mailbox; without, returns the only one or throws the ambiguity error (instead of silently returning `list[0]`).
- `deleteMailbox(projectId, mailboxIdOrSlug?)` — the existing `mailboxId` arg is generalized to accept a slug too (id fast-path preserved). Deleting still requires the explicit target when ambiguous.
- `Webhooks` methods take a trailing `opts?: { mailbox?: string }`; the class's injected resolver becomes `(projectId, selector?) => this.resolveMailbox(projectId, selector)`.

All additions are optional → no break for existing single-mailbox callers.

### 3. `createMailbox` stops recovering on 409

Remove the `catch (ApiError 409) → listMailboxes → return list[0]` block. A 409 now propagates verbatim (`Slug already in use` / `Address is in cooldown period` / `Project mailbox limit reached (5)`). On success it still caches `mailbox_id`/`mailbox_address` (useful as the single-mailbox default). "Create-or-get" is no longer implicit — a caller that wants it lists/gets explicitly. This removes a silent-wrong-mailbox path; pre-revenue, no deprecation shim needed.

### 4. MCP + CLI selectors

- MCP: `mailbox: z.string().optional().describe("Target mailbox by slug or id. Omit only when the project has exactly one mailbox.")` on the 11 email/webhook tools; forwarded to the SDK.
- CLI: `--mailbox <slug|id>` on `send` / `list` / `get` / `get-raw` / `reply` / `info` / `delete` and `email webhooks *`. The ambiguity error from the SDK is reported through the existing `reportSdkError` path (stderr error envelope, non-zero exit) — consistent with `cli-output-shape`.

### 5. Keystore unchanged

`ProjectKeys.mailbox_id`/`mailbox_address` remain a single optional convenience slot, refreshed only on the single-mailbox resolution path and on `create`. No schema migration. (A future change could store a per-slug map or a "default mailbox" pointer; not needed now.)

## Risks / trade-offs

- **Extra GET on the omitted-selector path.** Acceptable — only when no selector is given; id selectors skip it. Correctness > one cached round-trip.
- **`create` idempotency removal is a behavior change.** Mitigated: it only changes the 409 path, which under the new gateway no longer means "you already have this mailbox"; the old behavior was unsafe. Called out in release notes + the `email-mailbox-selection` spec.
- **Surface breadth.** 11 MCP tools + 8 CLI subcommands + SDK. Mechanical once `resolveMailbox` lands; `sync.test.ts` enforces MCP/CLI parity so nothing is missed.

## Rollout

Lockstep minor bump (2.20.1 → 2.21.0) via `publish.yml` after merge to main. The workflow runs `npm test` (full suite) pre-publish, so the new SDK/MCP/CLI tests gate the release.
