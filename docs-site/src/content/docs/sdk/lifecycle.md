---
title: "Rehearsals, snapshots, and branches"
description: "Native SDK reference — lifecycle."
order: 50
---

## Rehearsals, snapshots, and branches

Rehearsal is automatic inside `apply()` and `r.up()`: when the plan's `rehearsal.available` is true (migrations, and the project has a live release), the plan is rehearsed on a contained branch and committed only on a passing report, bound to the report's `required_plan`. The result carries `rehearsal: { status: "passed", report, operation_id, branch_project_id }`, or `{ status: "skipped", reason: "no_live_release" | "no_migrations" | "migrations_unchanged" | "disabled" | "reviewed_plan" | "unsupported" }` (`migrations_unchanged`: every migration is already applied with an identical checksum — `plan.migrations.new` is empty — so nothing is rehearsed and a page-only redeploy ships in seconds). A failed rehearsal throws `Run402DeployError` with `code: "REHEARSAL_FAILED"` (the report is in `body.rehearsal`); nothing is committed. Pass `{ noRehearse: true }` to skip it. `onEvent` sees `rehearsal.started`, `rehearsal.finished`, and `rehearsal.skipped`.

The primitive is still there for experts: `r.project(id).apply.rehearse(planId, { teardown })` rehearses an already-persisted plan without committing (a project with no live release rehearses on an EMPTY branch — never a refusal).

Manual restore points are exposed as `r.snapshots` and the scoped `r.project(id).snapshots`. `restorePlan()` is the no-mutation loss-statement step; `restore()` requires the confirm token from the plan and performs the atomic offline-materialize-then-flip restore. Auth users/passkeys are restored only with `{ includeAuth: true }`; sessions and tokens are never restored.

Contained branch projects are exposed as `r.branches` and `r.project(id).branches`. Branch creation can capture a fresh snapshot or start from an existing snapshot, saves returned branch keys to the Node credential cache when available, defaults email to sandboxed, keeps cron off unless requested, and expires by TTL.

## Portable project archives

Portable archives are the SDK path for proving Cloud is the easiest place to start, not the only place the supported application can run. They are a vendor-lock-in trust artifact and are separate from allowance/spend-cap financial-risk controls. Archive v1 exports the supported Run402 Core runtime slice of a Cloud project, not an entire Cloud project.

Node happy path:

```ts
import { writeFile } from "node:fs/promises";
import {
  importArchiveToCore,
  inspectArchive,
  run402,
  verifyArchive,
} from "@run402/sdk/node";

const r = run402({ surface: "cli" });

const exported = await r.archives.export("prj_...", {
  scope: "portable-runtime-v1",
  auth: "stubs",
  consistency: "pause-writes",
  onProgress: (event) => console.log(JSON.stringify(event)),
});

await writeFile("./project.r402ar", exported.bytes);

const inspected = await inspectArchive("./project.r402ar");
const verified = await verifyArchive("./project.r402ar");

if (!verified.ok) {
  console.error(JSON.stringify(verified.diagnostics));
}

const imported = await importArchiveToCore({
  archivePath: "./project.r402ar",
  name: "imported-project",
  envFile: "./required.env",
  requireRunnable: true,
});

console.log({ inspected, imported });
```

The isomorphic SDK exposes `r.archives.create(projectId, opts)`, `get(projectId, archiveId)`, `wait(projectId, archiveId, opts)`, `download(projectId, archiveId)`, and `export(projectId, opts)`. The Node entry upgrades `r.archives` to add local `inspect(archivePath)`, `verify(archivePath)`, and `importToCore(opts)`, and also exports standalone `inspectArchive`, `verifyArchive`, `importArchiveToCore`, and `readEnvFile`.

Archive progress events and diagnostics use stable agent fields: `event`, `stage`, `resource_type`, `resource_id`, `project_id`, `status`, `completed_units`, `total_units`, `code`, `message`, `next_action`, `retryable`, and safe `context`. `verify` is offline and checks integrity and compatibility only; archives remain untrusted input. Core import verifies before mutation, creates a new Core project only, and accepts required secret values via `envFile` or `secretValues`. Secret values, auth credentials, logs, billing/allowance state, and managed Cloud operations are never exported in v1.
