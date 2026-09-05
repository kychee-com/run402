/**
 * `run402 repos` — the consolidated encrypted-repository family. One noun,
 * thirteen verbs, each one either a `gh repo` verb, a `git` verb meaning what
 * it means in git, or a plain-English verb for an operation with no analog.
 * `repo` singular resolves identically (`cli.mjs` dispatches both spellings
 * here).
 *
 * ARCHITECTURAL LAW: every piece of protocol behavior — crypto core,
 * keystore, creation journal, snapshot + capture, publication state
 * machines, ref transactions, verification budget, repair — lives ONCE in
 * `@run402/sdk` under `r.gitvault` (the SDK keeps that name; it is
 * infrastructure language). This module is a THIN ADAPTER: argument
 * parsing, TTY output, exit codes, local file I/O. It adds zero protocol
 * behavior of its own.
 *
 * Pipe contract (docs/style.md): the payload is JSON on stdout; every human
 * line (progress, the terminal-loss statement, advisories) goes to stderr,
 * so `run402 repos view | jq` stays clean.
 *
 * `cli/lib/gitvault.mjs` is a tombstone that answers every `gitvault <verb>`
 * spelling with a typed `COMMAND_MOVED` (naming its `repos` successor) or
 * `COMMAND_REMOVED` (for `reconcile`, which has none) error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import { withAutoApprove } from "./operator.mjs";
import { allowanceAuthHeaders, isCoreApiTarget, readAllowance, resolveProjectId } from "./config.mjs";
import { loadLiveControlPlaneSession } from "../core-dist/control-plane-session.js";
import { resolveOrgId, resolveOwningOrgId } from "./org-context.mjs";
import { resolveGitvaultTarget } from "./gitvault-target.mjs";
import { nextAction, claimOrgSlugAction, claimRepoNameAction } from "./next-actions.mjs";
import { resolveHarnessLabels, resolveSessionKey, resolveTaskLabel, persistSessionKey } from "./harness-context.mjs";
import { updateRoomState } from "./rooms-context.mjs";
import { printKeystoreLocation } from "./gitvault.mjs";
import {
  GITVAULT_BYO_HEADLINE_STATEMENT,
  GITVAULT_BYO_NO_PAYLOAD_COPY_STATEMENT,
  GITVAULT_BYO_UNMIRRORED_REMEDY_STATEMENT,
  GITVAULT_MIRROR_SETUP_HINT,
  gitvaultRemoteUrlForRepo,
} from "#sdk";
import { sdkStats, printVerboseStats, isVerbose } from "./stats.mjs";
import {
  normalizeArgv,
  hasHelp,
  assertKnownFlags,
  parseIntegerFlag,
  flagValue,
  requirePositionalCount,
  resolveProjectSelector,
  failUnknownSubcommand,
  validateRegularFile,
} from "./argparse.mjs";

/** Value-taking flags every vault-targeting subcommand accepts. */
const COMMON_VALUE_FLAGS = ["--project", "--repo"];

export const HELP = `run402 repos — your source, encrypted before it leaves the machine

Usage:
  run402 repos <verb> [options] — fifteen verbs, tiered by how often you reach for them:

Common:
  run402 repos create [name]  [--org <org_id>] [--dir <path>] [--tier <tier>] [--project <id>]
                              [--byo <s3://bucket/prefix>] [--profile <name> | --ambient] [--region <r>] [--endpoint <url>] [--no-init]
  run402 repos view           [--project <id>] [--repo <repo_id>] [--human]
  run402 repos list           [--org <org_id>] [--human]

Then plain git, forever:
  git push
  git clone run402::<org>/<repo>

Handoff (pass a working tree to another agent):
  run402 repos handoff [--project <id>] [--repo <repo_id>] [--ttl <seconds>] [--role <role>]
                        [--include-sensitive <glob>]... [--note-file <path>] [--json] [--list] [--revoke <handoff_id>]
                        (the Handoff Note is JSON piped on stdin when not using --note-file)
  run402 repos resume  <kgh1_…|--key-stdin> [--to <dir>] [--no-init] [--json]

Invite (bring a second agent into the SAME work, dirty tree included):
  run402 repos invite  [--project <id>] [--repo <repo_id>] [--room <key>] [--ttl <seconds>] [--role <role>]
                        [--include-sensitive <glob>]... [--note-file <path>] [--json] [--list] [--revoke <invite_id>]
                        (the Invite Note is JSON piped on stdin when not using --note-file)
  run402 repos join    <kgi1_…|--key-stdin> [--to <dir>] [--no-init] [--json]

Occasional:
  run402 repos snapshot [--project <id>] [--repo <repo_id>] [--message <text>] [--checkpoint] [--dry-run] [--allow-dirty] [--manifest-out <path>]
  run402 repos mirror   [<destination>] [--off] [--backfill] [--profile <name> | --ambient] [--region <r>] [--endpoint <url>] [--project <id>] [--repo <repo_id>]
  run402 repos recover  <source> --out <dir> [--repo <repo_id>] [--profile <name> | --ambient] [--region <r>] [--endpoint <url>]
                        [--bundle <file>] [--code <SRC1-…>] [--receipt <file>] [--rp-id <host>] [--human]
  run402 repos recovery-bundle [--out <file> | --out -]

Lifecycle:
  run402 repos rename <new_name> [--repo <repo_id> | --project <project_id>]
  run402 repos delete [--project <id>] [--repo <repo_id>] [--force]

Maintenance:
  run402 repos fsck   [--project <id>] [--repo <repo_id>] [--mirror] [--budget <n>] [--no-write] [--human]
  run402 repos gc     [--project <id>] [--repo <repo_id>] [--force-headroom] [--submit --intent-core <path> --verifier-receipt <path> [--wait]]
  run402 repos daemon <status|stop>   The resident helper engine (gitvault-persistent-helper) — inspect or retire it; nothing requires either
  run402 repos access [--project <id>] [--repo <repo_id>] [--human]
  run402 repos access repair [--project <id>] [--repo <repo_id>] --recipient-state-version <n> --recipient-revocation-version <n>
  run402 repos access revoke-key <principal_id> [--project <id>] [--repo <repo_id>]
  run402 repos access declare-exposure [--project <id>] [--repo <repo_id>]
  run402 repos access repin   [--project <id>] [--repo <repo_id>] --principal <principal_id> --fingerprint <ek_fingerprint>
  run402 repos policy <required|grandfathered> [--project <id>] [--repo <repo_id>] [--reason <why>]
  run402 repos policy auto-gc [<generations>|off]   (local, per-checkout — no --project/--repo)

Every verb above also accepts -v/--verbose (a stderr summary line of request
stats — round trips, wire time, bytes — coexists with --human) and always
carries a \`stats\` block in its JSON result.

Subcommands:
  create   Provision (or, with --project, ADOPT an existing project), ALLOCATE
           its vault (mints key material and, on first allocation, a one-shot
           recovery receipt), and scaffold the git remote — origin when free,
           run402 when taken. \`--project <id>\` allocates for a project that already exists,
           nothing is provisioned. \`[name]\` is inferred from an existing git
           remote's basename or the directory name when unambiguous — NEVER a
           prompt; if the directory and an existing remote disagree, or
           nothing usable can be derived, this is a structured error naming
           exactly one next_action, never a guess. The response's next_action
           is the exact \`git push\` to run. Nothing is deployed, ever, unless
           you separately choose to. \`--byo <s3://bucket/prefix>\` allocates a
           BYO (bring-your-own-bucket) vault: source ciphertext is written
           ONLY to your own bucket, never run402's — run402 holds the small
           signed chain only. The destination is PROBED before anything is
           allocated (create-only writes honored, versioning disabled, write
           permitted) and refuses closed on any failed property. Fewer
           copies than a managed vault by construction (the platform holds
           no payload copy at all); \`run402 repos mirror <destination>\`
           still works unchanged as your second customer-held location.
           On a machine with no wallet, or a wallet with no active tier, this folds the cold-start
           chain (allowance -> faucet -> one x402 prototype payment,
           announced) before retrying once; \`--no-init\` opts out.
  view     Side-effect-free: what this machine and the control plane each
           believe about the repo — allocation, policy, whether this keystore
           can sign, the authenticated and materialized pins, the mirror
           summary (when one is configured), and where the keystore lives.
           NEVER materializes refs or advances any local pin —
           that belongs to \`fsck\`, which is why \`refs\` reports
           {known:false, reason:"not_materialized"} with a next_action
           pointing there. \`--human\` renders a short summary instead of JSON.
  list     The organization's vault-bearing repos, via the bulk
           vaults-by-org read when the gateway has it (one round trip);
           gracefully falls back to the older per-project walk when it
           404s. Not every project in the org — ones with no vault are
           omitted. \`--human\` renders a compact roster (address,
           generation, bytes, policy) instead of JSON.
  handoff  Capture a stash-shaped checkpoint (dirty work included, by
           default — unlike \`snapshot\`) and mint a single-use Handoff Key
           (\`kgh1_…\`), printed ONCE to stdout; the blast-radius warning
           ("anyone holding this key becomes a <role> of this org until
           first use or <expires_at>") and every other line go to stderr.
           The Handoff Note (what happened / what's next) is JSON on
           stdin (or \`--note-file <path>\`) — no manifest, it is generated.
           \`--ttl <seconds>\` (60..86400, default 3600), \`--role <role>\`
           (defaults to your own, never wider), \`--include-sensitive
           <glob>\` re-admits a named untracked path the sensitive denylist
           would otherwise exclude (repeatable). \`--list\`/\`--revoke
           <handoff_id>\` read/revoke instead of minting.
  resume   Resume a Handoff Key on ANY machine: parses the key; on a wallet
           with no active tier first folds the same cold-start chain
           \`create\` does (allowance → faucet → one x402 prototype payment,
           each step announced) so the resumed agent arrives as a paid-up
           run402 wallet of its own — \`--no-init\` opts out, and because the
           claim itself needs no tier a chain failure is reported (never
           blocks the resume); then claims the key with THIS machine's own
           wallet, clones the vault at the base HEAD
           into \`--to <dir>\` (default: the vault's name), applies the
           stash-shaped checkpoint (staged/unstaged/deleted/untracked
           restored distinctly), pins the repo/org/room into the checkout's
           LOCAL git config only, and renders the Handoff Note as Markdown.
           \`<kgh1_…>\` or \`--key-stdin\` (avoids shell mangling).
  invite   Capture a stash-shaped checkpoint exactly like \`handoff\`, but
           mint a single-use Invite Key (\`kgi1_…\`) that admits the
           recipient to a SHARED coordination room while you keep working —
           your worktree, index, branch, refs, and access are all
           untouched. Registers your own presence in the room (default: the
           project's own room; \`--room <key>\` names an org room) and posts
           ONE message naming the checkpoint and the invite id (never the
           key). \`--role\` narrows the minted role (defaults to
           \`developer\`, never wider than your own); \`--ttl <seconds>\`
           (60..86400, default 3600).
           \`--list\`/\`--revoke <invite_id>\` read/revoke instead of minting.
           Minting requires an ACTIVE writer key on this vault: a session
           whose key is not admitted is refused
           \`INVITE_MINT_REQUIRES_WRITER\` — have a live writer run
           \`run402 repos access sync\` (any push does it too), then retry.
  join     Claim an Invite Key on ANY machine: the SAME cold-start fold
           \`resume\` runs (allowance → faucet → one x402 prototype payment,
           announced — \`--no-init\` opts out; a chain failure never blocks
           the claim), clones the vault at the base HEAD into \`--to <dir>\`
           (default: the vault's name), restores the stash-shaped
           checkpoint exactly like \`resume\`, pins \`r402.room\` to the
           INVITE's own room, adds \`.run402/\` to \`.git/info/exclude\`,
           registers this session's presence, activates THIS machine's own
           key as a writer of the vault before returning (so \`git push\`
           works at once, under your own key, while the inviter keeps
           pushing), and reports who invited you (name, labels, liveness),
           who else is live, and the last few messages —
           \`run402 messages wait\` is your ear from here.
           \`<kgi1_…>\` or \`--key-stdin\` (avoids shell mangling).
  rename   Claim or rename the repo's per-org-unique, address-form name
           (the <name> half of run402::<org-slug>/<name>). Address by
           --repo or --project (not both).
  delete   Deletes a REPO-ONLY project — database, functions, subdomains,
           mailbox, and secrets must all be absent. When any of
           them is materialized, this REFUSES with
           PROJECT_HAS_NON_REPO_RESOURCES, enumerates refused_resources, and
           points at \`run402 projects delete\` — the verb whose name says
           what it destroys. \`--force\` overrides ONLY the vault-history
           confirmation below it (the repo holds admitted generations); it
           NEVER overrides the non-repo-infra refusal. Success enumerates
           deleted_resources.
  snapshot Capture the working tree and publish it. Not gated on a deploy —
           a vault-only repo snapshots for months without one. Against a
           project with no vault yet, this ALLOCATES one inline before
           publishing. Push-to-creates through a slug-form remote
           (run402::<org-slug>/<name>) the same way \`git push\` does.
           \`--dry-run\` previews the real local pipeline without publishing.
           A DIRTY tree (modified/staged tracked paths, or untracked-not-
           ignored paths) REFUSES by default (SNAPSHOT_DIRTY_TREE, before any
           object is created) — commit and retry, or pass \`--allow-dirty\` to
           capture it as-is; the result then discloses exactly what was
           swept in (modified_captured / untracked_captured), printed to
           stderr too. \`--dry-run\` surfaces the same refusal.
           Both \`--dry-run\` and a real snapshot print a SUMMARY by default —
           file counts (files_total/files_changed/files_new), total/delta
           bytes, and up to 200 changed/new paths (changed_more names any
           overflow) — never the full captured-file inventory, which can run
           to thousands of entries on a real repo. \`--manifest-out <path>\`
           writes the complete inventory to a file (the result's
           manifest_path names it); \`-v\`/\`--verbose\` inlines the full
           inventory directly in the JSON (in addition to its usual stderr
           stats line, not instead of it).
  mirror   ONE flag-driven verb for the client-side, customer-
           owned ciphertext mirror — run402 never holds a credential to it.
           No argument: READ the configured destination + a keyless
           freshness check against the live vault. \`<destination>\`:
           configure (idempotent upsert). \`--off\`: remove the config only —
           never touches the mirror's own bytes. \`--backfill\`: copy every
           object the mirror is missing (every publish already dual-pushes
           automatically; backfill exists for a pre-existing vault or a
           mirror that fell behind). Exactly one of these per call. Mirror
           state also renders inside \`repos view\`; mirror INTEGRITY inside
           \`repos fsck --mirror\`.
  recover  \`r402s-recover\`: rebuild a BARE recovery repository (no working
           files) straight from a mirrored prefix, with NO SERVER INVOLVED —
           the offline disaster path (normal retrieval is plain \`git clone
           run402::<org>/<repo>\`, no \`repos clone\` verb exists). The result's
           \`layout\` is \`"bare"\` and its \`next_actions\` print the exact
           \`git clone <out_dir> <out_dir>-worktree\` to run for a working
           tree — recover itself never checks files out. Proves this
           mirror's validity, never freshness — read both honesty statements
           before relying on the result. \`--human\` renders a short summary
           instead of JSON.
           A human member under wrapper custody (no keystore) recovers with
           their exported recovery bundle + source recovery code:
           \`--bundle <file>\` (omit to use the mirror's own
           member-recovery-bundles/ sidecar) + \`--code\` (prompted, hidden,
           when omitted) + \`--receipt <pin.json>\` (the vault's one-shot
           recovery receipt — key material never substitutes for the trust
           anchor). A raw WebAuthn PRF output is NOT a supported input; a
           code with no exported bundle refuses by name (a server-side
           wrapper row that was never exported is not offline backup).
  recovery-bundle
           Export YOUR member recovery bundle
           (r402s-member-recovery-bundle/v1): key identity + every ACTIVE
           wrapper ciphertext — the file \`recover --bundle\` opens with the
           source recovery code, kept SEPARATELY. A server-side wrapper row
           alone is NOT offline backup; this export is. Writes
           run402-source-recovery-bundle-<fingerprint>.json (0600) in the
           cwd unless \`--out\` says otherwise (\`--out -\` prints only); the
           full JSON always goes to stdout. Principal-scoped, not
           repo-scoped (one bundle covers every vault you can read) — auth
           is your control-plane session (\`run402 operator login
           --loopback\` first; without one it answers for the active
           WALLET's agent principal, normally no wrappers, and says so).
           To make it travel WITH a mirror, copy it to
           member-recovery-bundles/<name>.json under the mirrored prefix —
           \`recover\` finds it there automatically. Enrollment/activation/
           revocation are browser ceremonies: console.run402.com/account.
           Your own wrapper custody also renders in \`repos access\` (its
           member_custody block) when a control-plane session is cached.
  fsck     Walks the head chain AND materializes
           the ref map, advancing BOTH
           local trust pins — reported EXPLICITLY as local_state_changed +
           pin_before + pin_after, never implied. \`--no-write\` is a genuine
           audit mode: the same real walk and decrypt, computing the same
           real answer, but persisting neither pin. \`--budget <n>\` caps
           heads verified per call (the verified prefix persists under
           normal writing mode, so a budget-exceeded run resumes). \`--mirror\`
           additionally runs the keyless mirror integrity probe — it proves
           the mirror's VALIDITY, never its FRESHNESS, and says so.
           For a BYO vault (\`repos create --byo\`), fsck ALSO adjudicates
           the customer's own bucket against run402's signed chain —
           automatic, no flag needed. No local BYO credentials on this
           machine reports an explicit NOT CHECKED line, never a failure;
           a confirmed absence FAILS fsck with GITVAULT_BYO_OBJECT_MISSING
           naming exactly what's missing. Runs under \`--no-write\` too (a
           pure HEAD-check read). See the result's \`byo_presence\` block
           (also on \`--human\`); absent entirely for a managed vault.
           In write mode (not \`--no-write\`), when this keystore holds a
           local encryption identity, fsck ALSO submits its own
           chain-verified/decryptable generations as a proof-of-open receipt
           (\`recipient_open_receipt\`, D210) — best-effort: it never changes
           fsck's own verdict, and its outcome rides the result's
           \`open_proof\` block (also surfaced on \`--human\`).
           \`--human\` renders a short summary instead of JSON.
  gc       \`git gc\`'s own two halves — checkpoint publication (compact) and
           prune planning — in one verb, NOT described as "exactly git gc":
           the deletion ceremony is stricter. Plans and checkpoints by
           default; nothing is deleted until \`--submit --intent-core <path>
           --verifier-receipt <path>\` supplies BOTH receipts the two-phase
           protocol requires (this CLI's own + an independent one from
           r402s-verify — ships as prebuilt release binaries, not a
           build-from-source errand). The plan response's submit next_action
           carries destructive:true / requires_approval:true /
           safe_to_auto_execute:false as ADDITIVE fields.
  access   READ-ONLY: the org's directory of encryption-key-holding members,
           which of the vault's current envelope-recipient fingerprints are
           covered, per-recipient envelope_state (converged/pending/
           pending_removal, from the gateway's desired-recipient-state
           substrate), and (best-effort, this machine only) each principal's
           local TOFU pin. stale_access names removed members whose access
           has NOT yet been rotated away — pending_removal is honest
           bookkeeping, not enforcement, until \`access repair\`/\`revoke-key\`
           actually rotates. history_scope (which epochs each recipient can
           read) is not reported by this read — see the \`gap\` field. An
           enrolled teammate's key envelope is wrapped AUTOMATICALLY — no
           manual step — by the next \`git push\` or \`repos snapshot\` any
           key-holding client runs (best-effort, non-blocking; the retired
           \`gitvault reconcile\` verb did this by hand and is REMOVED).
           \`--human\` renders a compact roster instead of JSON (the read
           form only — repair/revoke-key/declare-exposure stay JSON-only).
  access repair
           Epoch rotation (D193-D203, rev 42) with reason:"elective_rekey" —
           re-keys this vault's CURRENT epoch away from every stale_access
           principal at once, and clears a pre-existing vault's one-time
           migration requirement. \`reconcile\`, the workaround this
           replaces, is REMOVED (it never wrapped a key correctly-scoped to
           "from here forward" — this does). Needs
           --recipient-state-version and --recipient-revocation-version:
           the gateway exposes no read route for these two counters outside
           \`revoke-key\`'s own response, so this verb needs them supplied
           explicitly today — refuses cleanly, naming exactly this, when
           omitted. Owner + step-up.
  access revoke-key <principal_id>
           The ONE fully self-contained rotation entry point: declares
           reason:"recipient_key_revoked" for one principal and rotates off
           that declaration's OWN returned counters — no flags needed.
           Owner + step-up. The rekey remedy for "this specific principal's
           key should no longer be trusted."
  access declare-exposure
           Declares reason:"epoch_secret_exposed" for THIS vault
           (vault-scoped, not org-wide) — the rekey remedy for a leaked
           K_repo/K_e. The declaration itself lands immediately; the
           follow-up rotation it authorizes is not auto-run (same counter
           gap as \`access repair\`) — this prints exactly what to do next.
           Owner + step-up.
  policy   Set the activation policy — \`required\` (a deploy must present a
           vaulted capture) or \`grandfathered\` (it need not). Owner +
           step-up, audited. \`grandfathered\` is the documented way out of a
           deploy the vault gate refused, and needs \`--reason\`; returning to
           \`required\` does not. Allocating a repo never sets this.
  policy auto-gc [<generations>|off]
           A LOCAL, per-checkout setting (git config, like git's own
           \`gc.auto\` — no network call, no --project/--repo/--reason): the
           post-push compaction cadence (gitvault-checkpoint-cadence).
           Default 32 — after a push, once this many generations have
           accumulated since the vault's last checkpoint, \`gc\`'s
           compact+prune-plan cycle runs automatically (one stderr advisory
           without a resident daemon; silently in the background with one).
           \`off\` (or \`0\`) disables it. No value prints the current setting.

Options:
  --project <id>    Project whose repo to act on (defaults to the active project)
  --repo <repo_id>  Address the repo directly by id, skipping project lookup
  --org <org_id>    create/list: the owning organization (create resolves it
                    the same way \`projects provision\` does when omitted)
  --dir <path>      create: the working tree to scaffold (default: cwd). Not
                    a git repository yet? One is created — \`repos create\` is
                    a from-a-directory-to-a-hosted-repo verb by definition.
  --tier <tier>     create: project tier (default: prototype) — new projects only
  --idempotency-key <key>
                    create: re-running with the same key resolves to the
                    same project instead of creating a second one — new
                    projects only (default: derived from the name).
                    access repair/revoke-key: the rotation attempt's OWN
                    client_idempotency_key (32-hex) — default: a fresh
                    CSPRNG value each call, never resumed across processes.
  --recipient-state-version <n>
  --recipient-revocation-version <n>
                    access repair: the D194 frozen watermark pair this
                    rotation attempt is fenced against. Required — see
                    \`run402 repos access repair --help\` for why.
  --human           view/list/access/fsck/recover: a short summary on stdout
                    instead of the JSON dump. Rejected together with --json.
  --force           delete: proceed even though the repo holds generations
                    that would be permanently and irrecoverably lost. Never
                    overrides the non-repo-infrastructure refusal.
  --message <text>  snapshot: commit message for the synthetic commit a dirty
                    tree produces (a clean tree pushes HEAD itself, unused)
  --checkpoint      snapshot: force the checkpoint-bearing form regardless of delta size
  --dry-run         snapshot: a REAL preview — runs the actual local pipeline
                    and reports what would publish. Publishes nothing. A
                    dirty tree still refuses SNAPSHOT_DIRTY_TREE here (a
                    preview that hid the refusal would lie).
  --allow-dirty     snapshot: capture a dirty tree as-is instead of refusing.
                    The result discloses exactly what was swept in
                    (modified_captured / untracked_captured) — even this
                    override never captures silently.
  --manifest-out <path>
                    snapshot: write the complete captured-file inventory
                    (the full JSON the SDK returned, untouched) to a private
                    0600 file instead of stdout's default summary. The
                    printed result's manifest_path names it. Composes with
                    --dry-run and with -v/--verbose.
  --off             mirror: remove the configured destination (config only)
  --backfill        mirror: copy every object the configured mirror is missing
  --profile <name>  mirror / recover: the AWS credential profile name for an
                    s3:// destination (read from ~/.aws/credentials at USE
                    time — never stored). Mutually exclusive with --ambient.
  --ambient         mirror / recover: use the ambient AWS_ACCESS_KEY_ID /
                    AWS_SECRET_ACCESS_KEY environment chain instead of a profile.
  --region <r>      mirror / recover: AWS region for an s3:// destination
  --endpoint <url>  mirror / recover: an S3-compatible endpoint override
  --out <dir>       recover: where to materialize the recovered repository
  --bundle <file>   recover: an exported r402s-member-recovery-bundle/v1 (from
                    \`run402 repos recovery-bundle\` or the console's download).
                    Omit to use the mirror's member-recovery-bundles/ sidecar.
  --code <SRC1-…>   recover: the source recovery code that opens the bundle.
                    Prefer omitting it — with --bundle set it is prompted with
                    hidden input, so it never lands in shell history.
  --receipt <file>  recover: the vault's recovery-receipt pin as JSON (the
                    one-shot receipt from repo creation). Required for trusted
                    recovery when no keystore holds it — without any pin the
                    result is labeled unauthenticated_salvage.
  --rp-id <host>    recover: the seal-time ceremony host bound into the
                    wrapper context (default: the bundle's own rp_id, then
                    console.run402.com — where every wrapper is sealed today)
  --budget <n>      fsck: heads walked in this call (write mode persists the
                    verified prefix, so a budget-exceeded run resumes; a
                    --no-write run does not, since nothing was persisted)
  --mirror          fsck: also run the keyless mirror integrity probe
  --no-reconcile    view/access: defer the session-start envelope fulfilment
                    (a key-holder normally wraps every pending member on its
                    first ordinary read); reported as deferred_by_local_policy,
                    never as coverage. fsck/recover never wrap regardless.
  --no-write        fsck: audit mode — compute and report the real answer,
                    persist neither local trust pin
  --submit          gc: submit the planned prune intent. Requires
                    --intent-core and --verifier-receipt.
  --intent-core <path>
                    gc: the plan's intent_core, saved verbatim from a prior
                    planning run. A rebuilt core carries a different nonce,
                    so a receipt over it would no longer bind.
  --verifier-receipt <path>
                    gc: r402s-verify's verifier_receipt over that same core.
  --wait            gc: poll the submitted intent until the control-plane-
                    signed completion appears, instead of returning immediately
  --force-headroom  gc: compact even when the storage preflight says the org's
                    pooled tier storage cannot hold the transient footprint.
                    Compaction holds BOTH the new checkpoint and the
                    not-yet-pruned history until a prune completes -- roughly
                    2x source_bytes -- so an org near its cap can otherwise be
                    refused mid-upload. The platform's own quota enforcement
                    stays authoritative either way.
  --reason <why>    policy: why the policy is changing — recorded in the
                    audit event. REQUIRED for \`grandfathered\`.
  -v, --verbose     Print one stderr summary line of this call's request
                    stats (round trips, wire time, bytes). Coexists with
                    --human. The JSON result always carries a \`stats\` block
                    regardless of this flag. On \`snapshot\`/\`snapshot
                    --dry-run\`, ALSO inlines the full captured-file
                    inventory in stdout's JSON (composes with the stats
                    line — both happen, not one or the other).
  --json            No-op: stdout is already JSON.

Terminal loss (protocol §0):
  In V0-A, whole-machine or whole-keystore loss is terminal for repo history
  until human envelopes ship. \`view\` prints the full statement verbatim on
  stderr and carries it in its JSON — read it before you rely on it.

Examples:
  run402 repos create                       # name inferred from cwd/remote
  run402 repos create my-notes
  run402 repos create --project prj_1a2b3c  # allocate for an existing project
  git push -u origin HEAD                   # the printed next_action, verbatim
  run402 repos view --human
  run402 repos list --org org_1a2b3c --human
  run402 repos rename my-notes --project prj_1a2b3c
  run402 repos snapshot --dry-run
  run402 repos snapshot --dry-run --manifest-out /tmp/snapshot-plan.json
  run402 repos snapshot --allow-dirty
  run402 repos mirror s3://acme-vault-mirror --profile acme
  run402 repos mirror --backfill
  run402 repos fsck --mirror --human
  run402 repos gc
  run402 repos access --human
  run402 repos recover s3://acme-vault-mirror --out ./restored --human
  run402 repos recovery-bundle --out ./bundle.json
  run402 repos recover ./mirror-copy --out ./restored --receipt ./recovery-receipt.json --bundle ./bundle.json
  run402 repos delete --project prj_xyz --force
`;

// ─── shared targeting + printing ────

/**
 * Resolve which repo to act on, plus the local git tree. Resolution order:
 * explicit `--repo`/`--project` > the repo's own pin/remote
 * > RUN402_PROJECT_ID > the active project.
 */
async function vaultTarget(a) {
  const repoId = flagValue(a, "--repo");
  const project = flagValue(a, "--project");
  const repoDir = process.cwd();
  const resolved = await resolveGitvaultTarget({
    repoDir,
    explicitProjectId: project ?? undefined,
    explicitRepoId: repoId ?? undefined,
  });
  const target = { repo_dir: repoDir };
  if (repoId != null) target.repo_id = repoId;
  if (repoId == null || project != null) {
    if ("repo_id" in resolved && project == null) target.repo_id = resolved.repo_id;
    if ("project_id" in resolved) target.project_id = resolved.project_id ?? resolveProjectId(project);
  }
  return target;
}

/**
 * Print the protocol §0 terminal-loss statement, verbatim, from the SDK's own
 * constants — never paraphrased here. The SDK's `status()` already downgrades
 * this to the durability sentence when it has locally proven the vault has
 * >= 2 covering recipients (dogfood item 2: the single-principal terminal-loss
 * claim is false for that vault) — this function only renders whichever
 * statement the SDK selected, it never chooses between them itself.
 */
function printTerminalLoss(status) {
  console.error("");
  if (status.terminal_loss_statement) {
    console.error(status.terminal_loss_statement);
    console.error(status.terminal_loss_detail);
  } else if (status.durability_statement) {
    console.error(status.durability_statement);
    if (status.covering_recipients != null) console.error(`covering_recipients: ${status.covering_recipients}`);
  }
  console.error(`Back up this directory: ${status.keystore.root}`);
  console.error("");
}

/**
 * Print a verb's JSON result with the always-on `stats` block (Observability:
 * RUN402_TRACE + always-on stats + -v). `sdk.stats()` reflects only calls
 * made through THIS `sdk` instance — every verb below resolves one `sdk =
 * getSdk()` and reuses it for its own direct calls so the count is accurate
 * for the work this function did; calls a shared cross-cutting helper
 * (org/wallet resolution) makes through its own internal instance are not
 * reflected (see `cli/lib/stats.mjs`'s doc comment).
 */
function printJson(sdk, payload) {
  console.log(JSON.stringify({ ...payload, stats: sdkStats(sdk) }, null, 2));
}

const LARGE_OUTPUT_THRESHOLD_BYTES = 100 * 1024;

/**
 * docs/agent-response-design.md's CLI pipe-contract row: stdout ALWAYS keeps
 * the full JSON (never truncated); when a result is large it is ALSO written
 * to a private 0600 file with a one-line stderr breadcrumb naming the path.
 * Best-effort. Deliberately NEVER called on `create`'s result — that JSON
 * carries the one-shot recovery receipt, and a secret-bearing response is
 * never spilled into any cache path (agent-response-design's secrets rule).
 */
async function spillIfLarge(repoId, verb, payload) {
  const json = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(json, "utf8") <= LARGE_OUTPUT_THRESHOLD_BYTES) return;
  try {
    const { getGitvaultKeystoreRoot } = await import("#sdk/node");
    const dir = join(getGitvaultKeystoreRoot(), "reports");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${verb}-${repoId ?? "unknown"}-${Date.now()}.json`);
    writeFileSync(path, json, { mode: 0o600 });
    console.error(`(this result is large — the full JSON was also written to ${path})`);
  } catch {
    // best-effort only; stdout already carries the full result regardless
  }
}

/** Both mirror honesty statements, verbatim, wherever a mirror/recover result is shown. */
function printMirrorHonesty(result) {
  if (result?.validity_not_freshness) console.error(result.validity_not_freshness);
  if (result?.keystore_still_required) console.error(result.keystore_still_required);
}

function resolveMirrorCredential(a) {
  const profile = flagValue(a, "--profile");
  const ambient = a.includes("--ambient");
  if (profile != null && ambient) {
    fail({ code: "BAD_USAGE", message: "--profile and --ambient contradict each other.", hint: "Pick one credential source for the s3:// destination." });
  }
  if (profile != null) return { kind: "profile", profile };
  if (ambient) return { kind: "ambient" };
  return undefined;
}

function formatMirrorDestination(destination) {
  if (!destination) return "(none)";
  return destination.kind === "s3" ? `s3://${destination.bucket}/${destination.prefix}` : destination.path;
}

function readJsonFile(flag, path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    fail({ code: "BAD_USAGE", message: `${flag} ${path} could not be read: ${err?.message ?? String(err)}`, hint: "Point it at the file a prior `run402 repos gc` (or r402s-verify) wrote." });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail({ code: "BAD_USAGE", message: `${flag} ${path} is not valid JSON: ${err?.message ?? String(err)}`, hint: "Pass the file verbatim; do not reformat or re-serialize it." });
  }
}

function formatRepoAddress(s) {
  if (s.pinned?.resolved_from) return `run402::${s.pinned.resolved_from.org_slug}/${s.pinned.resolved_from.repo_name}`;
  const orgId = s.vault?.org_id ?? null;
  const projectId = s.project_id ?? s.vault?.project_id ?? null;
  if (orgId && projectId) return `run402::${orgId}/${projectId}`;
  if (projectId) return projectId;
  if (s.repo_id) return `repo ${s.repo_id}`;
  return "(unresolved)";
}

async function formatRepoHuman(s, mirror) {
  const lines = [];
  const remotePart = s.remote ? ` (remote '${s.remote.name}'${s.remote.matches ? "" : " — points at a DIFFERENT project"})` : " (no local remote)";
  lines.push(`Address: ${formatRepoAddress(s)}${remotePart}`);

  if (!s.vault) {
    lines.push("Repo: not allocated yet for this project — run 'run402 repos create --project <id>' to allocate one.");
    if (s.warnings.length > 0) lines.push(`Warnings: ${s.warnings.map((w) => w.message).join(" ")}`);
    return lines.join("\n");
  }

  lines.push("HEAD: (not materialized — run 'run402 repos fsck' to see HEAD/ref count; view never does)");

  const { generationToBigInt } = await import("#sdk/node");
  const decimal = (g) => (g ? generationToBigInt(g).toString() : "none");
  lines.push(`Generations: authenticated ${decimal(s.pins.highest_authenticated)}, materialized ${decimal(s.pins.highest_materialized)}`);

  const storage = s.vault.storage;
  const objectCount = storage?.objects ? Object.values(storage.objects).reduce((sum, n) => sum + Number(n), 0) : null;
  lines.push(storage ? `Storage: ${storage.source_bytes} byte(s)${objectCount != null ? ` across ${objectCount} object(s)` : ""}` : "Storage: unknown");

  // gitvault-byo-primary-bucket task 3.5 — unconditional, independent of
  // mirror status (D7).
  if (s.vault.storage_profile === "byo") {
    lines.push(`Storage profile: byo (${s.vault.byo_destination ?? "(unknown)"}) — ${GITVAULT_BYO_HEADLINE_STATEMENT}`);
    lines.push(GITVAULT_BYO_NO_PAYLOAD_COPY_STATEMENT);
  }

  const decryptPart = !s.keystore.holds_repo_key
    ? "CANNOT decrypt (no key in this machine's keystore)"
    : s.keystore.can_sign
      ? "can decrypt and publish"
      : "can decrypt (read-only — no signing key)";
  lines.push(`This machine: ${decryptPart}. Policy: ${s.gitvault_policy ?? "(none)"}`);

  // gitvault-multi-writer (rev 47) task 6.1 — the writer roster, one line
  // per writer: `writer_set` is the chain-verified set exactly as `verify`/
  // `fsck` would derive it (never re-verified here — this is `view`'s own
  // side-effect-free read of the vault RECORD's already-verified pointer).
  // `pending_writers` is the reverse direction (eligible org members not
  // yet admitted); `read_only_terminal` (D228) is the forced sole-writer-
  // removal terminal — surfaced prominently since a vault in that state
  // still serves reads but can never accept another push until recovered.
  const writerSet = s.vault.writer_set;
  if (writerSet) {
    lines.push(`Writers (${writerSet.writers.length}):`);
    for (const w of writerSet.writers) {
      lines.push(`  ${w.writer_key_id} — admitted generation ${w.admitted_generation} (${w.authorization_kind})`);
    }
    if (s.vault.read_only_terminal) {
      lines.push("  ⚠ read-only terminal: the last writer was removed — this vault serves reads but cannot accept a push until a new writer is admitted through a recovery path.");
    }
    const pendingWriters = s.vault.pending_writers ?? [];
    if (pendingWriters.length > 0) {
      lines.push(`Pending writers (${pendingWriters.length}, eligible but not yet admitted): ${pendingWriters.map((p) => p.writer_key_id).join(", ")} — run 'run402 repos access sync' if this machine is already a writer.`);
    }
  }

  // gitvault-mirror-default: the SDK-computed vault_unmirrored finding is
  // echoed verbatim (never rephrased here) — informational, never blocking.
  if (mirror?.finding) {
    lines.push(`Mirror (${mirror.finding.kind}): ${mirror.finding.message} — ${mirror.finding.setup_command}`);
  } else if (mirror?.configured) {
    const currency = mirror.is_current === true ? "current" : mirror.is_current === false ? "STALE" : "unknown";
    lines.push(`Mirror: ${mirror.destination} (${currency})`);
  }

  if (s.warnings.length > 0) lines.push(`Warnings: ${s.warnings.map((w) => w.message).join(" ")}`);
  return lines.join("\n");
}

// ─── name inference ──────────────────

function validateProjectName(name) {
  if (name === "") {
    fail({ code: "BAD_PROJECT_NAME", message: "the repo name must not be empty.", details: { field: "name" } });
  }
  if (name.length > 128) {
    fail({ code: "BAD_PROJECT_NAME", message: `the repo name must be 1-128 characters, got ${name.length}.`, details: { field: "name", length: name.length, max: 128 } });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) {
    fail({ code: "BAD_PROJECT_NAME", message: "the repo name contains control characters (newline, tab, etc).", details: { field: "name" } });
  }
}

/**
 * Best-effort slugify for the address-form repo name (the address-form
 * grammar: lowercase [a-z0-9-], no leading/trailing/double hyphen, <=63 chars).
 */
function slugifyRepoName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

/** The basename of an existing `run402`/`origin` remote's URL, or `null` when there is no repository or no such remote. Any remote — a GitHub URL parses fine too, not only a gitvault address. */
async function remoteBasenameCandidate(dir) {
  try {
    const { hardenedGit } = await import("#sdk/node");
    await hardenedGit(dir, ["rev-parse", "--git-dir"]);
    for (const name of ["run402", "origin"]) {
      let url;
      try {
        url = (await hardenedGit(dir, ["remote", "get-url", name])).text().trim();
      } catch {
        continue;
      }
      if (!url) continue;
      const stripped = url.replace(/\.git$/, "");
      const seg = stripped.split(/[/:]/).filter(Boolean).pop();
      if (seg) return seg;
    }
  } catch {
    // not a repository — no candidate
  }
  return null;
}

function dirBasenameCandidate(dir) {
  const base = basename(dir);
  return base && base !== "/" ? base : null;
}

/**
 * `repos create [name]`'s inference: the directory or an
 * existing git remote's basename, when unambiguous. NEVER a prompt —
 * ambiguity (the two candidates disagree) or a dead end (neither yields a
 * usable slug) is a structured error naming exactly one next_action.
 */
async function inferRepoName(dir) {
  const remoteCand = await remoteBasenameCandidate(dir);
  const dirCand = dirBasenameCandidate(dir);
  const remoteSlug = remoteCand ? slugifyRepoName(remoteCand) : null;
  const dirSlug = dirCand ? slugifyRepoName(dirCand) : null;

  if (remoteSlug && dirSlug && remoteSlug !== dirSlug) {
    fail({
      code: "REPOS_NAME_AMBIGUOUS",
      message: `Could not infer a repo name: the directory ("${dirCand}") and the existing git remote ("${remoteCand}") disagree.`,
      hint: "Pass the name explicitly.",
      details: { directory_candidate: dirSlug, remote_candidate: remoteSlug },
      next_actions: [nextAction("edit_request", { command: "run402 repos create <name>", why: "Inference could not pick between the directory and the existing remote — say which name you want." })],
    });
  }
  const picked = remoteSlug ?? dirSlug;
  if (!picked) {
    fail({
      code: "REPOS_NAME_REQUIRED",
      message: "Could not infer a repo name from the directory or an existing git remote.",
      hint: "Pass one explicitly.",
      next_actions: [nextAction("edit_request", { command: "run402 repos create <name>", why: "No usable name could be derived from cwd or a remote." })],
    });
  }
  return picked;
}

// ─── create ─────────────────────────────────────────────────────────────────

const CREATE_VALUE_FLAGS = ["--org", "--dir", "--tier", "--idempotency-key", "--project", "--byo", "--profile", "--region", "--endpoint"];

/** gitvault-byo-primary-bucket task 3.5 — `--byo <destination>` + the SAME credential/region/endpoint flags `repos mirror` already uses. `undefined` when `--byo` was not passed (byte-identical to today). */
function resolveByoOption(a) {
  const destinationUrl = flagValue(a, "--byo");
  if (destinationUrl == null) return undefined;
  const credential = resolveMirrorCredential(a);
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  return {
    destination_url: destinationUrl,
    ...(credential ? { credential } : {}),
    ...(region != null ? { region } : {}),
    ...(endpoint != null ? { endpoint } : {}),
  };
}

async function printCreateResult({ sdk, projectId, vault, adopted, name, verboseArgv }) {
  let address = null;
  let orgSlug = null;
  try {
    const owningOrg = await resolveOwningOrgId(projectId);
    const orgRecord = owningOrg ? await sdk.org(owningOrg).get() : null;
    orgSlug = orgRecord?.slug ?? null;
    if (orgSlug && name) {
      const candidate = slugifyRepoName(name);
      if (candidate) {
        const named = await sdk.projects.setRepoName(projectId, candidate);
        address = gitvaultRemoteUrlForRepo(orgSlug, named.repo_name);
      }
    }
  } catch (err) {
    if (name) console.error(`repo name not claimed (non-fatal): ${err?.message ?? String(err)}`);
  }

  const pushAction = vault.remote
    ? nextAction("push_repo", { command: `git push -u ${vault.remote.name} HEAD`, why: "Publish the current branch to the encrypted Run402 remote." })
    : null;
  const claimAction = address ? null : orgSlug ? claimRepoNameAction(projectId) : claimOrgSlugAction();
  // gitvault-byo-primary-bucket task 3.5: a BYO vault's "add a copy" remedy
  // names a SECOND customer-held location (D7) — the plain mirror hint
  // frames the mirror as the FIRST custody-held copy, which is false once
  // the vault's own primary bucket already is one.
  const isByo = vault.storage_profile === "byo";
  const mirrorAction = isByo
    ? nextAction("configure_mirror", { command: "run402 repos mirror <destination>", why: GITVAULT_BYO_UNMIRRORED_REMEDY_STATEMENT })
    : nextAction("configure_mirror", { command: "run402 repos mirror <destination>", why: GITVAULT_MIRROR_SETUP_HINT });
  const nextActions = [pushAction, mirrorAction, claimAction].filter(Boolean);

  // Secret-bearing (recovery_receipt): built fresh every call, printed once,
  // and never spilled into any cache path — see spillIfLarge's own doc
  // comment for why this function never calls it.
  const out = {
    project_id: projectId,
    repo_id: vault.repo_id,
    address,
    remote: vault.remote,
    deduplicated: vault.deduplicated,
    genesis_sha256: vault.genesis_sha256,
    recovery_receipt: vault.recovery_receipt,
    terminal_loss_statement: vault.terminal_loss_statement,
    storage_profile: vault.storage_profile,
    byo_destination: vault.byo_destination,
    deployed: false,
    next_actions: nextActions,
  };
  printJson(sdk, out);
  console.error(
    `project ${projectId} ${adopted ? "adopted" : "provisioned"}; repo ${vault.repo_id} ` +
    (vault.deduplicated ? "already existed — nothing was re-allocated" : `allocated (genesis ${vault.genesis_sha256})`),
  );
  if (address) console.error(`address: ${address}`);
  else if (!orgSlug) console.error("no named address yet — claim an org slug (run402 org slug <slug>) to get run402::<slug>/<name> addresses");
  else console.error(`no address claimed — run 'run402 repos rename <name> --project ${projectId}' to claim one`);
  if (vault.remote) console.error(`remote '${vault.remote.name}' -> ${vault.remote.url} (${vault.remote.reason})`);
  if (pushAction) console.error(`next: ${pushAction.command}`);
  if (isByo) {
    console.error(`storage: byo (${vault.byo_destination}) — ${GITVAULT_BYO_HEADLINE_STATEMENT}`);
    console.error(GITVAULT_BYO_NO_PAYLOAD_COPY_STATEMENT);
    console.error(GITVAULT_BYO_UNMIRRORED_REMEDY_STATEMENT);
  } else {
    console.error(GITVAULT_MIRROR_SETUP_HINT);
  }
  console.error("");
  console.error(vault.terminal_loss_statement);
  await printKeystoreLocation();
  console.error("");
  console.error("nothing was deployed — this is a vault-only repo. Deploy later with `run402 deploy apply`, or never.");
  printVerboseStats(verboseArgv, sdk);
}

async function createAdopt(projectId, dir, a) {
  const sdk = getSdk();
  const orgId = flagValue(a, "--org") ?? await resolveOwningOrgId(projectId);
  if (!orgId) {
    fail({
      code: "GITVAULT_ORG_UNRESOLVED",
      message: `Could not resolve the organization that owns ${projectId}.`,
      hint: "Pass --org <org_id>, or check that this wallet can see the project (`run402 projects list`).",
      details: { project_id: projectId },
    });
  }
  try {
    const byo = resolveByoOption(a);
    const vault = await sdk.gitvault.init({ org_id: orgId, project_id: projectId, repo_dir: dir, ...(byo ? { byo } : {}) });
    await printCreateResult({ sdk, projectId, vault, adopted: true, name: null, verboseArgv: a });
  } catch (err) {
    reportSdkError(err);
  }
}

async function createProvision(name, dir, a) {
  const sdk = getSdk();
  const tier = flagValue(a, "--tier") ?? "prototype";
  // `optional: true` — a fresh wallet with no org yet is the cold-start path
  // `projects provision` itself supports; `--org` targets an existing one.
  const orgId = await resolveOrgId(a, { cmd: "repos", optional: true });
  // The idempotency key names the ORG as well as the name: a provision replay
  // is scoped to the wallet, so a key of the name alone answers a second
  // `repos create` in a different org (same directory basename) with the
  // FIRST org's project — and writes a remote URL that mixes the new org id
  // with the old project id.
  const idempotencyKey = flagValue(a, "--idempotency-key") ?? `repos-create:${orgId ?? "org-of-one"}:${name}`;

  // A genuinely bare machine has no allowance file at all, and the NO_ALLOWANCE
  // precheck below would refuse before the provision call could ever answer
  // NO_ACTIVE_TIER, so the cold-start fold would never reach the one case it
  // exists for. Fold first when there is no wallet; `--no-init` keeps the
  // bare refusal.
  if (!isCoreApiTarget() && !loadLiveControlPlaneSession() && !readAllowance() && !a.includes("--no-init")) {
    console.error("no wallet on this machine — folding the cold-start chain (allowance -> faucet -> prototype tier)");
    try {
      const { foldColdStartChain } = await import("./cold-start.mjs");
      await foldColdStartChain((line) => console.error(`  ${line}`));
    } catch (chainErr) {
      reportSdkError(chainErr);
      return;
    }
  }
  if (!isCoreApiTarget() && !loadLiveControlPlaneSession()) allowanceAuthHeaders("/projects/v1");

  const provisionOnce = () =>
    withAutoApprove(() => sdk.projects.provision({ tier, name, ...(orgId ? { orgId } : {}), idempotencyKey }));

  let provisioned;
  try {
    provisioned = await provisionOnce();
  } catch (err) {
    // kygit-handoff design D5: `repos create` on a fresh wallet folds the
    // cold-start chain ONCE — allowance → faucet → one x402 prototype
    // payment, announced — then retries exactly once. `--no-init` opts
    // out (the caller wants the bare NO_ACTIVE_TIER refusal).
    const code = err?.body?.code ?? err?.code;
    if (code === "NO_ACTIVE_TIER" && !a.includes("--no-init")) {
      console.error("no active tier — folding the cold-start chain (allowance -> faucet -> prototype tier)");
      try {
        const { foldColdStartChain } = await import("./cold-start.mjs");
        await foldColdStartChain((line) => console.error(`  ${line}`));
      } catch (chainErr) {
        reportSdkError(chainErr);
        return;
      }
      try {
        provisioned = await provisionOnce();
      } catch (retryErr) {
        reportSdkError(retryErr);
        return;
      }
    } else {
      reportSdkError(err);
      return;
    }
  }

  const effectiveOrgId = orgId ?? (await resolveOwningOrgId(provisioned.project_id));
  if (!effectiveOrgId) {
    fail({
      code: "GITVAULT_ORG_UNRESOLVED",
      message: `Provisioned project ${provisioned.project_id}, but could not resolve its owning organization to allocate the repo.`,
      hint: `Pass --org <org_id> next time, or finish by hand: run402 repos create --project ${provisioned.project_id} --org <org_id>`,
      details: { project_id: provisioned.project_id },
      next_actions: [nextAction("edit_request", { command: `run402 repos create --project ${provisioned.project_id} --org <org_id>`, why: "the owning org could not be resolved automatically after provisioning" })],
    });
  }

  try {
    const byo = resolveByoOption(a);
    const vault = await sdk.gitvault.init({ org_id: effectiveOrgId, project_id: provisioned.project_id, repo_dir: dir, ...(byo ? { byo } : {}) });
    await printCreateResult({ sdk, projectId: provisioned.project_id, vault, adopted: false, name, verboseArgv: a });
  } catch (err) {
    reportSdkError(err);
  }
}

async function create(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...CREATE_VALUE_FLAGS, "--ambient", "--no-init", "--help", "-h", "-v", "--verbose"], CREATE_VALUE_FLAGS);
  const positionals = requirePositionalCount(a, CREATE_VALUE_FLAGS, {
    min: 0, max: 1, command: "run402 repos create [name]", missing: "",
  });
  let name = positionals[0] ?? null;
  const dir = flagValue(a, "--dir") ?? process.cwd();
  const adoptProjectId = flagValue(a, "--project");

  if (adoptProjectId != null) {
    if (name != null) {
      fail({
        code: "BAD_USAGE",
        message: "a name positional and --project are mutually exclusive — --project adopts an EXISTING project.",
        hint: "run402 repos create --project <id> to adopt, or run402 repos create <name> to provision a new one. Name it afterward with `run402 repos rename`.",
      });
    }
    if (flagValue(a, "--tier") != null || flagValue(a, "--idempotency-key") != null) {
      fail({
        code: "BAD_USAGE",
        message: "--tier / --idempotency-key only apply when provisioning a NEW project — they do not apply with --project.",
        hint: "Drop --project to provision a new project, or drop --tier/--idempotency-key to adopt the existing one.",
      });
    }
    return createAdopt(adoptProjectId, dir, a);
  }

  if (name == null) name = await inferRepoName(dir);
  validateProjectName(name);
  return createProvision(name, dir, a);
}

// ─── list ───────────────────────────────────────────────────────────────────

/** The FROZEN bulk-read shape (task 2.4) — one round trip. */
async function listViaBulkRead(sdk, orgId) {
  const result = await sdk.gitvault.listByOrg(orgId);
  return Array.isArray(result.vaults) ? result.vaults : [];
}

/**
 * DEPRECATED fallback, kept only until every deployed gateway answers
 * `GET /gitvault/v1/vaults?org_id=`: the old client-side N+1 (list the
 * org's projects, then read each one's gitvault status). Delete this
 * function once the bulk route has shipped long enough that no gateway
 * still 404s it.
 */
async function listViaFallback(sdk, orgId) {
  const result = await sdk.projects.list({ org: orgId });
  const projects = Array.isArray(result.projects) ? result.projects : [];
  const repos = [];
  for (const p of projects) {
    let status;
    try {
      status = await sdk.gitvault.status({ project_id: p.id });
    } catch {
      continue;
    }
    if (!status.vault) continue;
    repos.push({
      repo_id: status.repo_id,
      project_id: p.id,
      project_name: p.name ?? null,
      repo_name: null,
      org_slug: null,
      gitvault_policy: status.vault.gitvault_policy,
      newest_generation: status.vault.newest_generation ?? null,
      source_bytes: String(status.vault.storage?.source_bytes ?? "0"),
      genesis_admitted_at: status.vault.genesis_admitted_at,
      created_at: null,
    });
  }
  return repos;
}

/** `repos list --human`: a compact roster — one line per repo (address, generation, bytes, policy). */
async function formatRepoListHuman(orgSlug, repos) {
  if (repos.length === 0) return "(no vault-bearing repos in this organization)";
  const { generationToBigInt } = await import("#sdk/node");
  const decimal = (g) => (g ? generationToBigInt(g).toString() : "none");
  const lines = repos.map((r) => {
    const address = orgSlug && r.repo_name ? gitvaultRemoteUrlForRepo(orgSlug, r.repo_name) : (r.repo_name ?? r.project_id);
    return `${address}  gen=${decimal(r.newest_generation)}  ${r.source_bytes} byte(s)  policy=${r.gitvault_policy ?? "(none)"}  (${r.repo_id})`;
  });
  return lines.join("\n");
}

async function list(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--org", "--human", "-v", "--verbose", "--help", "-h"], ["--org"]);
  requirePositionalCount(a, ["--org"], { min: 0, max: 0, command: "run402 repos list", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const orgId = await resolveOrgId(a, { cmd: "repos" });

  let repos;
  let usedFallback = false;
  try {
    repos = await listViaBulkRead(sdk, orgId);
  } catch (err) {
    if (err?.status === 404) {
      usedFallback = true;
      try {
        repos = await listViaFallback(sdk, orgId);
      } catch (fallbackErr) {
        reportSdkError(fallbackErr);
        return;
      }
    } else {
      reportSdkError(err);
      return;
    }
  }

  let orgSlug = repos.find((r) => r.org_slug)?.org_slug ?? null;
  if (orgSlug == null) {
    try {
      orgSlug = (await sdk.org(orgId).get()).slug;
    } catch {
      // best-effort — `list` must not fail over an org-slug lookup
    }
  }

  if (human) {
    console.log(await formatRepoListHuman(orgSlug, repos));
    printVerboseStats(a, sdk);
    return;
  }
  printJson(sdk, { org_id: orgId, org_slug: orgSlug, repos });
  console.error(`${repos.length} vault-bearing project(s) in this organization${usedFallback ? " (per-project fallback read — the bulk vaults-by-org route is not live on this gateway yet)" : ""}`);
  if (orgSlug) console.error(`org slug: ${orgSlug} — a repo with a claimed address-form name is reachable at run402::${orgSlug}/<name>`);
  printVerboseStats(a, sdk);
}

// ─── view ───────────────────────────────────────────────────────────────────

async function view(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--human", "--no-reconcile", "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos view", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    // Design D3: `view` NEVER passes `refs: true` — it is side-effect-free
    // by construction, not by convention. Materialization belongs to `fsck`.
    const s = await sdk.gitvault.status({ ...target, ...(a.includes("--no-reconcile") ? { reconcile: "deferred" } : {}) });
    const isByo = s.vault?.storage_profile === "byo";
    let mirror = null;
    if (s.repo_id) {
      try {
        mirror = await sdk.gitvault.mirrorStatus({ ...target, repo_id: s.repo_id, is_byo: isByo });
      } catch {
        // best-effort — a mirror read failure never fails `view`
      }
    }
    if (human) {
      console.log(await formatRepoHuman(s, mirror));
      printVerboseStats(a, sdk);
      return;
    }
    const verifyRefsAction = nextAction("verify_refs", { command: "run402 repos fsck", why: "Walk the signed chain and materialize verified refs." });
    const combinedNextActions = s.vault ? [verifyRefsAction, ...(s.next_actions ?? [])] : (s.next_actions ?? []);
    // kygit-handoff design D8 — the mirror of the OLD `npm i -g run402`
    // bug, pointing the other way: a `kygit::` remote with no
    // `git-remote-kygit` on PATH fails every push/clone/fetch inside git.
    let warnings = s.warnings ?? [];
    if (s.remote?.url?.startsWith("kygit::")) {
      const { isExecutableOnPath } = await import("./path-lookup.mjs");
      if (!isExecutableOnPath("git-remote-kygit")) {
        warnings = [...warnings, { kind: "kygit_helper_missing", message: "this checkout's remote is kygit:: but git-remote-kygit is not on PATH", setup_command: "npm i -g @kychee/kygit" }];
      }
    }
    const out = {
      ...s,
      warnings,
      refs: { known: false, reason: "not_materialized" },
      mirror,
      next_actions: combinedNextActions,
    };
    printJson(sdk, out);
    printTerminalLoss(s);
    if (s.remote) {
      const suffix =
        s.remote.matches === false ? "  ← points at a DIFFERENT project than this view"
        : s.remote.matches === null ? `  (${s.remote.reason})`
        : "";
      console.error(`remote '${s.remote.name}': ${s.remote.url}${suffix}`);
    }
    if (s.pinned) {
      console.error(`pinned: repo_id ${s.pinned.repo_id}` + (s.pinned.resolved_from ? ` (resolved from run402::${s.pinned.resolved_from.org_slug}/${s.pinned.resolved_from.repo_name})` : "") + (s.pinned.room ? `, room ${s.pinned.room}` : ""));
    }
    // kygit-invite design D9's risk list: ".git/info/exclude is per-clone and
    // silent" — `messaging_cache_excluded` makes the state visible rather
    // than leaving it a fact only `cat .git/info/exclude` would reveal.
    if (s.messaging_cache_excluded !== null && s.messaging_cache_excluded !== undefined) {
      console.error(`messaging cache excluded from git: ${s.messaging_cache_excluded}`);
    }
    // gitvault-byo-primary-bucket task 3.5: the no-payload-copy disclosure —
    // unconditional and independent of mirror status (D7), never folded
    // into the mirror finding below (that's a SEPARATE fact: "is there a
    // second copy", not "is there any platform-held copy at all").
    if (isByo) {
      console.error(`storage: byo (${s.vault?.byo_destination ?? "(unknown)"}) — ${GITVAULT_BYO_HEADLINE_STATEMENT}`);
      console.error(GITVAULT_BYO_NO_PAYLOAD_COPY_STATEMENT);
    }
    if (mirror?.configured) {
      const currency = mirror.is_current === true ? "current" : mirror.is_current === false ? `STALE — ${mirror.closing_command}` : "unknown (mirror unreachable or vault unread)";
      console.error(`mirror ${mirror.destination}: mirrored generation ${mirror.mirrored_generation ?? "(none)"}, vault newest ${mirror.newest_generation ?? "(none)"} — ${currency}`);
    }
    // gitvault-mirror-default: echoed verbatim from the SDK, exactly like the
    // vault warnings below — informational, never blocking, and it clears on
    // the first successful mirror write or sync.
    if (mirror?.finding) console.error(`finding (${mirror.finding.kind}): ${mirror.finding.message} — ${mirror.finding.setup_command}`);
    for (const w of warnings) console.error(`warning (${w.kind}): ${w.message}${w.setup_command ? ` — ${w.setup_command}` : ""}`);
    for (const n of combinedNextActions) console.error(`next: ${n.why ?? n.action ?? n.type}${n.command ? ` — ${n.command}` : ""}`);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── rename ─────────────────────────────────────────────────────────────────

async function rename(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  const [repoName] = requirePositionalCount(a, COMMON_VALUE_FLAGS, {
    min: 1, max: 1, command: "run402 repos rename <new_name> [--repo <repo_id> | --project <project_id>]",
    missing: "run402 repos rename <new_name>: a new name is required",
  });
  const sdk = getSdk();
  const repoFlag = flagValue(a, "--repo");
  const projectFlag = flagValue(a, "--project");
  if (repoFlag != null && projectFlag != null) {
    fail({ code: "BAD_USAGE", message: "pass --repo or --project, not both.", hint: "They address the same repo two different ways." });
  }
  let projectId;
  if (repoFlag != null) {
    try {
      projectId = (await sdk.gitvault.get(repoFlag)).project_id;
    } catch (err) {
      reportSdkError(err);
      return;
    }
  } else {
    projectId = resolveProjectId(projectFlag);
  }
  try {
    const result = await sdk.projects.setRepoName(projectId, repoName);
    let address = null;
    try {
      const owningOrg = await resolveOwningOrgId(projectId);
      const orgSlug = owningOrg ? (await sdk.org(owningOrg).get()).slug : null;
      if (orgSlug) address = gitvaultRemoteUrlForRepo(orgSlug, result.repo_name);
    } catch {
      // The claim itself already succeeded — a failed address-preview lookup is never fatal.
    }
    printJson(sdk, { ...result, address });
    console.error(
      result.previous_repo_name && result.previous_repo_name !== result.repo_name
        ? `renamed from "${result.previous_repo_name}" to "${result.repo_name}"`
        : `name "${result.repo_name}" claimed for ${projectId}`,
    );
    if (address) console.error(`address: ${address}`);
    else console.error("this org has no slug yet — claim one with `run402 org slug <slug>` to get a full run402::<slug>/<name> address");
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── delete ─────────────────────────────────────────────────────

/** One non-repo-resource read, `null` when absent (including a clean 404), an entry when present or genuinely unverifiable. */
async function checkResource(read, resourceName, countOf) {
  try {
    const result = await read();
    const count = countOf(result);
    return count > 0 ? { resource: resourceName, status: "present", count } : null;
  } catch (err) {
    if (err?.status === 404) return null; // genuinely absent, not a check failure
    return { resource: resourceName, status: "unknown", reason: err?.message ?? String(err) };
  }
}

/**
 * D9's guard: a repo-only project has no materialized database schema, no
 * functions, no secrets, no subdomains, no mailbox, no custom domains. Every
 * read here uses the SAME service-key credential `projects.delete` itself
 * requires, so a credential that would make `delete` fail also makes this
 * guard fail the same way — never a silent pass on missing auth. A read
 * that fails for a reason OTHER than "genuinely absent" (404) is reported
 * `unknown` and REFUSES delete too — D9 never guesses its way to yes.
 */
async function checkNonRepoResources(sdk, projectId) {
  const refused = [];
  try {
    const detail = await sdk.projects.get(projectId);
    if (Array.isArray(detail.mailbox) && detail.mailbox.length > 0) refused.push({ resource: "mailbox", status: "present", count: detail.mailbox.length });
    if (Array.isArray(detail.custom_domains) && detail.custom_domains.length > 0) refused.push({ resource: "custom_domains", status: "present", count: detail.custom_domains.length });
  } catch (err) {
    refused.push({ resource: "project_detail", status: "unknown", reason: err?.message ?? String(err) });
  }
  const schema = await checkResource(() => sdk.projects.getSchema(projectId), "database_schema", (s) => (Array.isArray(s?.tables) ? s.tables.length : 0));
  if (schema) refused.push(schema);
  const functions = await checkResource(() => sdk.functions.list(projectId), "functions", (r) => (Array.isArray(r?.functions) ? r.functions.length : 0));
  if (functions) refused.push(functions);
  const secrets = await checkResource(() => sdk.secrets.list(projectId), "secrets", (r) => (Array.isArray(r?.secrets) ? r.secrets.length : 0));
  if (secrets) refused.push(secrets);
  const subdomains = await checkResource(() => sdk.subdomains.list(projectId), "subdomains", (r) => (Array.isArray(r) ? r.length : 0));
  if (subdomains) refused.push(subdomains);
  return refused;
}

function stripFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1) return args;
  const copy = [...args];
  copy.splice(idx, 2);
  return copy;
}

async function del(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--project", "--repo", "--force", "-v", "--verbose", "--help", "-h"], ["--project", "--repo"]);
  const sdk = getSdk();
  const repoFlag = flagValue(a, "--repo");
  let projectId;
  let rest;
  if (repoFlag != null) {
    if (flagValue(a, "--project") != null) {
      fail({ code: "BAD_USAGE", message: "pass --repo or --project, not both." });
    }
    try {
      projectId = (await sdk.gitvault.get(repoFlag)).project_id;
    } catch (err) {
      reportSdkError(err);
      return;
    }
    rest = stripFlag(a, "--repo");
  } else {
    ({ projectId, rest } = resolveProjectSelector(a, { rejectBareFirst: true }));
  }
  requirePositionalCount(rest.filter((x) => x !== "--force"), [], { min: 0, max: 0, command: "run402 repos delete [--project <id>] [--repo <repo_id>] [--force]", missing: "" });
  const force = a.includes("--force");

  let status;
  try {
    status = await sdk.gitvault.status({ project_id: projectId });
  } catch (err) {
    reportSdkError(err);
    return;
  }
  const vault = status.vault;
  const admittedGenerations = vault ? Number(vault.admitted_generations ?? "0") : 0;
  const sourceBytes = vault ? Number(vault.storage?.source_bytes ?? "0") : 0;

  // D9, checked FIRST and unconditionally: --force below overrides only the
  // vault-history confirmation, never this refusal.
  const refusedResources = await checkNonRepoResources(sdk, projectId);
  if (refusedResources.length > 0) {
    fail({
      code: "PROJECT_HAS_NON_REPO_RESOURCES",
      message: `project ${projectId} holds non-repo infrastructure; \`repos delete\` only destroys a repo-only project.`,
      hint: "Use `run402 projects delete <project_id>` to destroy the whole project, including what is listed below. --force does NOT override this refusal.",
      details: { project_id: projectId, refused_resources: refusedResources },
      next_actions: [nextAction("edit_request", { command: `run402 projects delete ${projectId}`, why: "Destroys the whole project, including the non-repo resources listed above." })],
    });
  }

  if (vault && admittedGenerations > 0 && !force) {
    fail({
      code: "CONFIRMATION_REQUIRED",
      message:
        `repo ${status.repo_id} for project ${projectId} holds ${admittedGenerations} admitted generation(s) ` +
        `(${sourceBytes} bytes of encrypted source, genesis ${vault.genesis_admitted_at ?? "unknown"}) — ` +
        "deleting the project destroys its entire encrypted history irrecoverably. Re-run with --force to proceed.",
      details: {
        project_id: projectId,
        repo_id: status.repo_id,
        admitted_generations: admittedGenerations,
        source_bytes: sourceBytes,
        genesis_admitted_at: vault.genesis_admitted_at,
        destroys: ["vault_history"],
      },
    });
  }

  try {
    await sdk.projects.delete(projectId);
    printJson(sdk, {
      project_id: projectId,
      deleted: true,
      deleted_resources: ["project", ...(vault ? ["vault_history"] : [])],
      vault: vault ? { repo_id: status.repo_id, admitted_generations: admittedGenerations, source_bytes: sourceBytes } : null,
    });
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── snapshot ───────────────────────────────────────────────────────────────

const SNAPSHOT_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--message", "--manifest-out"];

/**
 * When neither `--repo` nor `--project` was given explicitly, look at the
 * local `run402`/`origin` remote and, if it is a SLUG-form address
 * (`run402::<org-slug>/<name>`), return the parsed address so `snapshot`
 * can push-to-create through it — the same address-form resolution
 * `git push` drives via the remote helper.
 */
async function detectSlugFormRemote(a, repoDir) {
  if (flagValue(a, "--repo") != null || flagValue(a, "--project") != null) return null;
  const { hardenedGit } = await import("#sdk/node");
  const { parseGitvaultRemoteUrl, gitvaultRemoteAddressForm } = await import("#sdk");
  for (const name of ["run402", "origin"]) {
    let url;
    try {
      url = (await hardenedGit(repoDir, ["remote", "get-url", name])).text().trim();
    } catch {
      continue;
    }
    if (!url) continue;
    const address = parseGitvaultRemoteUrl(url);
    if (address && gitvaultRemoteAddressForm(address) === "slug") return address;
  }
  return null;
}

/**
 * Dirty-tree disclosure (help people not make mistakes): even an explicit
 * `--allow-dirty` override never captures silently — every modified/staged
 * tracked path and every untracked-not-ignored path that got swept into the
 * capture is named on stderr, one per line.
 */
function printDirtyDisclosure(snapshot) {
  if (!snapshot) return;
  for (const p of snapshot.modified_captured ?? []) console.error(`captured (modified): ${p}`);
  for (const p of snapshot.untracked_captured ?? []) console.error(`captured (untracked): ${p}`);
}

/** How many `changed_paths` entries {@link summarizeSnapshotPayload} inlines before capping. */
const SNAPSHOT_CHANGED_PATHS_CAP = 200;

/**
 * item 1 (dogfood): `snapshot.captured` — the SDK's full captured-file
 * inventory (every tracked + untracked-not-ignored path in the repo, always
 * populated regardless of how small the actual push delta is) — is a
 * multi-thousand-line flood on a real repo, even when what actually
 * publishes is a handful of kilobytes. The SDK keeps returning it in full
 * (thin-shim law: other SDK consumers may want it) — this reshapes ONLY the
 * CLI's own stdout, by default:
 *
 *   - `files_total` / `files_changed` / `files_new` — counts. `files_total`
 *     is `captured.length`; `files_changed`/`files_new` are
 *     `modified_captured`/`untracked_captured` — the ONLY per-path drift
 *     this data distinguishes (the `--allow-dirty` sweep-in disclosure).
 *     On the common clean-tree path both are empty, so `changed_paths` is
 *     too — there is no `files_deleted` here, because `captured` only
 *     lists paths PRESENT on disk today; nothing in this data names which
 *     paths a plain clean push's new commits touched.
 *   - `changed_paths` — `modified_captured` ∪ `untracked_captured`,
 *     sorted, capped at `SNAPSHOT_CHANGED_PATHS_CAP`; `changed_more` names
 *     the overflow explicitly rather than truncating silently.
 *   - `snapshot.captured` / `.paths` / `.modified_captured` /
 *     `.untracked_captured` are dropped from the default `snapshot` object
 *     (its other scalar fields — kind, oid, tree_oid, head, head_oid,
 *     captured_digest, top_level, global_excludes_path — stay). `verbose`
 *     restores them (composes with the summary fields, does not replace
 *     them) — the `-v`/`--verbose` flag already means "print a stats
 *     line"; on `snapshot --dry-run`/`snapshot` it ALSO inlines the full
 *     inventory.
 *   - `manifest_path` is `null` unless `--manifest-out <path>` wrote the
 *     COMPLETE, untouched payload to that file — see `writeManifestOut`.
 */
function summarizeSnapshotPayload(payload, { verbose = false, manifestPath = null } = {}) {
  const out = { ...payload, manifest_path: manifestPath };
  const snapshot = payload.snapshot;
  if (!snapshot) return out;
  const modified = snapshot.modified_captured ?? [];
  const untracked = snapshot.untracked_captured ?? [];
  const changedAll = [...modified, ...untracked].sort();
  const changedPaths = changedAll.slice(0, SNAPSHOT_CHANGED_PATHS_CAP);
  out.files_total = Array.isArray(snapshot.captured) ? snapshot.captured.length : 0;
  out.files_changed = modified.length;
  out.files_new = untracked.length;
  out.changed_paths = changedPaths;
  out.changed_more = changedAll.length - changedPaths.length;
  if (!verbose) {
    const { captured, paths, modified_captured, untracked_captured, ...trimmedSnapshot } = snapshot;
    out.snapshot = trimmedSnapshot;
  }
  return out;
}

/** `--manifest-out <path>`: write the COMPLETE, untouched plan/push payload — the full captured-file inventory included — to a private 0600 file. */
function writeManifestOut(path, payload) {
  try {
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch (e) {
    fail({
      code: "MANIFEST_OUT_WRITE_FAILED",
      message: `could not write the full snapshot inventory to ${path}: ${e instanceof Error ? e.message : String(e)}`,
      hint: "Check that the path is writable and its parent directory exists.",
      details: { path },
    });
  }
}

async function snapshot(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...SNAPSHOT_VALUE_FLAGS, "--checkpoint", "--dry-run", "--allow-dirty", "-v", "--verbose", "--help", "-h"], SNAPSHOT_VALUE_FLAGS);
  requirePositionalCount(a, SNAPSHOT_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos snapshot", missing: "" });
  const sdk = getSdk();
  const dryRun = a.includes("--dry-run");
  const message = flagValue(a, "--message");
  const allowDirty = a.includes("--allow-dirty");
  const repoDir = process.cwd();
  const address = await detectSlugFormRemote(a, repoDir);
  const target = address ? { repo_dir: repoDir } : await vaultTarget(a);
  const orgId = !address && !dryRun && target.project_id ? await resolveOwningOrgId(target.project_id) : null;
  const opts = {
    ...target,
    ...(address ? { address } : {}),
    ...(orgId ? { org_id: orgId } : {}),
    onCommitLine: (line) => console.error(line),
    onVaultCreated: async (created) => {
      console.error("");
      console.error(`repo allocated (genesis ${created.genesis_sha256}) — one-shot recovery receipt, keep many copies:`);
      console.error(JSON.stringify(created.recovery_receipt));
      // gitvault-mirror-default: lazy allocation is a birth too — the mirror
      // one-liner rides beside the recovery receipt here as well.
      console.error(GITVAULT_MIRROR_SETUP_HINT);
      await printKeystoreLocation();
      console.error("");
    },
  };
  const snapshotOpts = {};
  if (message != null) snapshotOpts.message = message;
  if (allowDirty) snapshotOpts.allowDirty = true;
  if (Object.keys(snapshotOpts).length > 0) opts.snapshot = snapshotOpts;
  if (a.includes("--checkpoint")) opts.checkpoint = true;
  const manifestOutPath = flagValue(a, "--manifest-out");
  const verbose = isVerbose(a);
  try {
    if (dryRun) {
      const plan = await sdk.gitvault.planPush(opts);
      if (manifestOutPath != null) writeManifestOut(manifestOutPath, plan);
      printJson(sdk, summarizeSnapshotPayload(plan, { verbose, manifestPath: manifestOutPath }));
      if (plan.allocation_needed) {
        console.error("dry-run: no repo allocated for this project yet — a real snapshot would allocate one first; object/byte sizing is not knowable until then");
      } else {
        console.error(
          `dry-run: would publish generation ${plan.would_admit_generation} (${plan.would_admit_generation_decimal}, ${plan.form}) — ` +
          `${plan.object_count} object(s), ${plan.encrypted_bytes} encrypted byte(s) (${plan.raw_bytes} raw)`,
        );
      }
      printDirtyDisclosure(plan.snapshot);
      printVerboseStats(a, sdk);
      return;
    }
    const result = await sdk.gitvault.push(opts);
    if (manifestOutPath != null) writeManifestOut(manifestOutPath, result);
    // Snapshot-only vault (no branch head published): a plain `git clone`
    // of this vault prints "cloned an empty repository" with no hint the
    // snapshot exists. Name the restore path in the result itself.
    const resultRefNames = Object.keys(result.refs ?? {});
    const snapshotOnly = resultRefNames.length > 0 && !resultRefNames.some((r) => r.startsWith("refs/heads/"));
    const payload = summarizeSnapshotPayload(result, { verbose, manifestPath: manifestOutPath });
    // gitvault-clone-scaling (P3): advisory only — the SDK computed the
    // staleness from locally-learned coverage; this entry never gates.
    if (result.checkpoint_staleness?.advised) {
      payload.next_actions = [
        ...(payload.next_actions ?? []),
        {
          type: "compact_advised",
          command: "run402 repos gc",
          why: `${result.checkpoint_staleness.generations_since_checkpoint} generations since the last checkpoint — cold clones re-verify each one; compaction folds them into one checkpoint.`,
        },
      ];
    }
    if (snapshotOnly) {
      const snapRef = resultRefNames.sort()[0];
      payload.next_actions = [
        ...(payload.next_actions ?? []),
        {
          type: "restore_snapshot_ref",
          command: `git fetch <remote> '+${snapRef}:${snapRef}' && git checkout -b restored ${snapRef}`,
          why: `This vault has no branch heads — a plain \`git clone\` will report an empty repository. The snapshot history lives on ${snapRef}; \`git push\` a branch to make plain clones work.`,
        },
      ];
    }
    printJson(sdk, payload);
    console.error(`published generation ${result.generation} (${result.form})`);
    if (snapshotOnly) console.error(`note: no branch heads in this vault — a plain clone looks empty; snapshot history is on ${resultRefNames.sort()[0]} (see next_actions)`);
    if (result.mirror_push?.outcome === "pushed") {
      console.error(`mirror: pushed generation ${result.generation} (${result.mirror_push.summary?.objects_copied ?? 0} object(s) copied)`);
    } else if (result.mirror_push?.outcome === "failed") {
      console.error(`mirror: dual-push FAILED (deploy is unaffected) — ${result.mirror_push.error ?? "see mirror_push.summary.errors"}`);
    }
    printDirtyDisclosure(result.snapshot);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── handoff / resume (kygit-handoff) ────────────────────────────────────────

const HANDOFF_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--ttl", "--role", "--include-sensitive", "--revoke", "--note-file"];
const RESUME_VALUE_FLAGS = ["--to"];

/** All occurrences of a repeatable value flag (only `--include-sensitive` needs this today). */
function flagValues(args, flag) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const v = args[i + 1];
      if (v == null || (typeof v === "string" && v.startsWith("--"))) {
        fail({ code: "BAD_FLAG", message: `${flag} requires a value`, details: { flag } });
      }
      out.push(v);
    }
  }
  return out;
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * The Handoff Note has no CLI flags of its own (design: "no manifest — the
 * note is generated") — the calling harness composes it and pipes it as
 * JSON on stdin, mirroring `jobs submit --stdin`'s convention but implicit
 * (no `--stdin` flag needed: a piped, non-TTY stdin IS the note source).
 * `--note-file <path>` is the explicit, script-friendly alternative.
 */
async function readHandoffNoteInput(a) {
  const noteFile = flagValue(a, "--note-file");
  if (noteFile != null) {
    validateRegularFile(noteFile, "--note-file");
    return parseHandoffNoteJson(readFileSync(noteFile, "utf-8"), noteFile);
  }
  if (process.stdin?.isTTY) {
    fail({
      code: "BAD_USAGE",
      message: "Missing the Handoff Note on stdin.",
      hint: "Pipe the note as JSON (schema kygit.handoff-note.v1, minus `capture`), or use --note-file <path>.",
    });
  }
  const text = await readStdinText();
  if (text.trim().length === 0) {
    fail({
      code: "BAD_USAGE",
      message: "Missing the Handoff Note on stdin.",
      hint: "Pipe the note as JSON, or use --note-file <path>.",
    });
  }
  return parseHandoffNoteJson(text, "stdin");
}

/** The invite-kind sibling of {@link readHandoffNoteInput} (kygit-invite design D3/D9). */
async function readInviteNoteInput(a) {
  const noteFile = flagValue(a, "--note-file");
  if (noteFile != null) {
    validateRegularFile(noteFile, "--note-file");
    return parseInviteNoteJson(readFileSync(noteFile, "utf-8"), noteFile);
  }
  if (process.stdin?.isTTY) {
    fail({
      code: "BAD_USAGE",
      message: "Missing the Invite Note on stdin.",
      hint: "Pipe the note as JSON (schema kygit.invite-note.v1, minus `capture`), or use --note-file <path>.",
    });
  }
  const text = await readStdinText();
  if (text.trim().length === 0) {
    fail({
      code: "BAD_USAGE",
      message: "Missing the Invite Note on stdin.",
      hint: "Pipe the note as JSON, or use --note-file <path>.",
    });
  }
  return parseInviteNoteJson(text, "stdin");
}

/** Shared body for `parseHandoffNoteJson`/`parseInviteNoteJson` — `schema`/`kindLabel` name the claim kind's own vocabulary. */
function parseClaimNoteJson(text, source, schema, kindLabel, helpCommand) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail({ code: "BAD_USAGE", message: `The ${kindLabel} Note from ${source} is not valid JSON.`, hint: `Pipe a JSON object matching ${schema} (minus \`capture\`, which is filled in for you).` });
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.summary !== "string") {
    fail({ code: "BAD_USAGE", message: `The ${kindLabel} Note from ${source} is missing a \`summary\` string.`, hint: `See \`${helpCommand}\` for the note shape.` });
  }
  const now = new Date().toISOString();
  return {
    schema,
    created_at: typeof parsed.created_at === "string" ? parsed.created_at : now,
    from: parsed.from ?? { agent: "unspecified" },
    summary: parsed.summary,
    ...(parsed.completed !== undefined ? { completed: parsed.completed } : {}),
    ...(parsed.in_progress !== undefined ? { in_progress: parsed.in_progress } : {}),
    ...(parsed.failing !== undefined ? { failing: parsed.failing } : {}),
    ...(parsed.tried !== undefined ? { tried: parsed.tried } : {}),
    ...(parsed.next_steps !== undefined ? { next_steps: parsed.next_steps } : {}),
    ...(parsed.commands !== undefined ? { commands: parsed.commands } : {}),
    ...(parsed.decisions !== undefined ? { decisions: parsed.decisions } : {}),
    ...(parsed.open_questions !== undefined ? { open_questions: parsed.open_questions } : {}),
  };
}

function parseHandoffNoteJson(text, source) {
  return parseClaimNoteJson(text, source, "kygit.handoff-note.v1", "Handoff", "run402 repos handoff --help");
}

function parseInviteNoteJson(text, source) {
  return parseClaimNoteJson(text, source, "kygit.invite-note.v1", "Invite", "run402 repos invite --help");
}

async function handoff(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...HANDOFF_VALUE_FLAGS, "--json", "--list", "-v", "--verbose", "--help", "-h"], HANDOFF_VALUE_FLAGS);
  const sdk = getSdk();
  const asJson = a.includes("--json");
  const verbose = isVerbose(a);

  if (a.includes("--list")) {
    const target = await vaultTarget(a);
    try {
      const result = await sdk.gitvault.listHandoffs(target);
      printJson(sdk, result);
      printVerboseStats(a, sdk);
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }
  const revokeId = flagValue(a, "--revoke");
  if (revokeId != null) {
    const target = await vaultTarget(a);
    try {
      const result = await sdk.gitvault.revokeHandoff(revokeId, target);
      printJson(sdk, result);
      printVerboseStats(a, sdk);
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  const note = await readHandoffNoteInput(a);
  const ttlRaw = flagValue(a, "--ttl");
  const ttlSeconds = ttlRaw != null ? parseIntegerFlag("--ttl", ttlRaw, { min: 60, max: 86400 }) : undefined;
  const role = flagValue(a, "--role");
  const includeSensitive = flagValues(a, "--include-sensitive");
  const target = await vaultTarget(a);

  const opts = {
    ...target,
    note,
    ...(role != null ? { role } : {}),
    ...(ttlSeconds != null ? { ttlSeconds } : {}),
    ...(includeSensitive.length > 0 ? { includeSensitive } : {}),
    onCommitLine: (line) => console.error(line),
  };
  try {
    const result = await sdk.gitvault.handoff(opts);
    for (const w of result.warnings ?? []) {
      console.error(w.message ?? `${w.code}`);
    }
    console.error(`handoff minted: role ${result.minted_role}, expires ${result.expires_at}`);
    // gitvault-multi-writer (rev 47) task 6.4 — a handoff is now also a
    // WRITER admission, not just a checkout pass: the recipient signs its
    // own future pushes with a NEW key this vault's chain recognizes as a
    // writer the moment `resume` claims it (design D4 — a grant minted here,
    // a two-signature acceptance the recipient's own resume completes).
    console.error(`the recipient becomes a WRITER on this vault the moment they resume — their own key signs future pushes, not yours.`);
    console.error(`recipient runs: kygit resume <key printed below>`);
    if (asJson) {
      printJson(sdk, result);
    } else {
      // The key alone, so `KEY=$(run402 repos handoff)` works — everything
      // else (the blast-radius warning, the commit line) is on stderr.
      console.log(result.handoff_key);
    }
    printVerboseStats(a, sdk);
    void verbose;
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * Whether this wallet needs the cold-start chain before a resume: no
 * allowance file yet (a fresh machine — the viral case), or an allowance
 * whose org holds no active tier. An unreachable tier status reads as
 * "no" — the claim needs no tier, and a resume must never wait on a status
 * read.
 */
async function resumeNeedsColdStart(sdk) {
  if (!readAllowance()) return true;
  try {
    const status = await sdk.tier.status();
    return status?.active === false;
  } catch {
    return false;
  }
}

/**
 * `resume`'s cold-start fold: the SAME chain `create` runs on
 * NO_ACTIVE_TIER (`cold-start.mjs`), announced step by step on stderr.
 * Never throws — a failure is returned as `{ error, next_action }` so the
 * caller carries it in the result and proceeds with the claim.
 */
async function foldColdStartForResume(sdk) {
  if (!(await resumeNeedsColdStart(sdk))) return { performed: false, skipped: "tier_active" };
  console.error("no active tier — folding the cold-start chain (allowance -> faucet -> prototype tier) before the claim");
  try {
    const { foldColdStartChain } = await import("./cold-start.mjs");
    const chain = await foldColdStartChain((line) => console.error(`  ${line}`));
    return { performed: true, ...chain };
  } catch (err) {
    const code = err?.body?.code ?? err?.code ?? null;
    const message = err?.body?.message ?? err?.message ?? String(err);
    console.error(`cold-start chain failed (${code ?? "error"}: ${message}) — continuing with the claim; run \`run402 tier set prototype\` afterwards`);
    return {
      performed: false,
      error: { code, message },
      next_action: { type: "renew_tier", command: "run402 tier set prototype", why: "The resume proceeded without a tier of your own; the perpetual prototype tier is what lets this wallet create and deploy projects." },
    };
  }
}

/** `kygit.handoff-note.v1` / `kygit.invite-note.v1` rendered as Markdown — shared body, `title` names the claim kind ("Handoff" or "Invite"). */
function renderClaimNoteMarkdown(note, title) {
  if (!note) return null;
  const lines = [];
  lines.push(`# ${title} — ${note.from?.agent ?? "unknown agent"}${note.from?.model ? ` (${note.from.model})` : ""}`);
  lines.push("");
  lines.push(note.summary ?? "");
  const section = (title, items) => {
    if (!items || items.length === 0) return;
    lines.push("");
    lines.push(`## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section("Completed", note.completed);
  section("In progress", note.in_progress);
  section("Failing", note.failing);
  section("Tried", note.tried);
  section("Next steps", note.next_steps);
  section("Decisions", note.decisions);
  section("Open questions", note.open_questions);
  if (note.commands && (note.commands.test || note.commands.build || note.commands.run)) {
    lines.push("");
    lines.push("## Commands");
    if (note.commands.test) lines.push(`- test: \`${note.commands.test}\``);
    if (note.commands.build) lines.push(`- build: \`${note.commands.build}\``);
    if (note.commands.run) lines.push(`- run: \`${note.commands.run}\``);
  }
  if (note.capture) {
    lines.push("");
    lines.push("## Capture");
    lines.push(`- base: ${note.capture.base_head}${note.capture.branch ? ` (${note.capture.branch})` : ""}`);
    lines.push(`- modified: ${note.capture.modified_captured}, untracked: ${note.capture.untracked_captured}`);
    if (note.capture.sensitive_excluded?.length) lines.push(`- excluded (sensitive): ${note.capture.sensitive_excluded.join(", ")}`);
    if (note.capture.ignored_not_transferred_count) lines.push(`- ignored (not transferred): ${note.capture.ignored_not_transferred_count}`);
  }
  return lines.join("\n");
}

/** `resume`'s default (non-`--json`) rendering — the Handoff Note as Markdown. */
function renderHandoffNoteMarkdown(note) {
  return renderClaimNoteMarkdown(note, "Handoff");
}

/** `join`'s default (non-`--json`) rendering — the Invite Note as Markdown (kygit-invite design D5). */
function renderInviteNoteMarkdown(note) {
  return renderClaimNoteMarkdown(note, "Invite");
}

async function resume(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...RESUME_VALUE_FLAGS, "--key-stdin", "--no-init", "--json", "-v", "--verbose", "--help", "-h"], RESUME_VALUE_FLAGS);
  const sdk = getSdk();
  const keyStdin = a.includes("--key-stdin");
  const to = flagValue(a, "--to");
  const positionals = requirePositionalCount(a, [...RESUME_VALUE_FLAGS], { min: keyStdin ? 0 : 1, max: keyStdin ? 0 : 1, command: "run402 repos resume <kgh1_…|--key-stdin>", missing: "Missing the Handoff Key (positional argument, or --key-stdin)." });
  let key = positionals[0] ?? null;
  if (keyStdin) {
    key = (await readStdinText()).trim();
    if (!key) fail({ code: "BAD_USAGE", message: "Missing the Handoff Key on stdin.", hint: "Pipe the kgh1_… key, or pass it as a positional argument." });
  }
  // A resumed agent is a NEW run402 wallet, and the loop is the
  // point — so on a wallet with no active tier `resume` folds the same
  // cold-start chain `create` does (allowance → faucet → one x402
  // prototype payment, announced) BEFORE the claim. The claim itself needs
  // no tier, so the chain is never allowed to block a resume: a faucet
  // throttle or payment failure is reported on stderr, carried in the
  // result as `cold_start.error` with a `renew_tier` next action, and the
  // claim proceeds (the SDK still creates the bare wallet it needs).
  // `--no-init` opts out entirely.
  const coldStart = a.includes("--no-init") ? { performed: false, skipped: "no_init" } : await foldColdStartForResume(sdk);
  try {
    const result = await sdk.gitvault.resume({ key, ...(to != null ? { to } : {}), onLine: (line) => console.error(line) });
    if (coldStart.next_action) result.next_actions = [...(result.next_actions ?? []), coldStart.next_action];
    if (a.includes("--json")) {
      printJson(sdk, { ...result, cold_start: coldStart });
    } else {
      const rendered = renderHandoffNoteMarkdown(result.note) ?? result.note_raw;
      if (rendered) {
        console.log(rendered);
      }
      console.error("");
      console.error(`resumed into ${result.restored.dir} (branch ${result.restored.branch})`);
      // gitvault-multi-writer (rev 47) task 6.4 — this checkout's own writer
      // activation (design D5): the outcome is "active" either way, whether
      // this call submitted a fresh activation head or a prior attempt's
      // already landed (crash-resumable, task 5.6's own idempotent-skip).
      if (result.writer_activation) {
        console.error(`writer: ${result.writer_activation.outcome} (generation ${result.writer_activation.generation})`);
      }
      if (result.deduplicated) console.error("note: this key was already claimed by this same principal — the ORIGINAL envelope was reused (safe replay)");
      for (const na of result.next_actions ?? []) {
        if (na.command) console.error(`next: ${na.command}${na.why ? ` — ${na.why}` : ""}`);
      }
    }
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── invite / join (kygit-invite) ────────────────────────────────────────────

const INVITE_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--ttl", "--role", "--include-sensitive", "--revoke", "--note-file", "--room"];
const JOIN_VALUE_FLAGS = ["--to"];

/**
 * `run402 repos invite` — capture a stash-shaped checkpoint (design D1,
 * identical to `handoff`), register the inviter's own presence in the
 * invite's room, mint through the gateway, post ONE fact from that
 * presence, and print the assembled `kgi1_…` key exactly once (kygit-invite
 * design D4). Never touches the inviter's worktree, index, branch, refs, or
 * access.
 */
async function invite(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...INVITE_VALUE_FLAGS, "--json", "--list", "-v", "--verbose", "--help", "-h"], INVITE_VALUE_FLAGS);
  const sdk = getSdk();
  const asJson = a.includes("--json");
  const verbose = isVerbose(a);

  if (a.includes("--list")) {
    const target = await vaultTarget(a);
    try {
      const result = await sdk.gitvault.listInvites(target);
      printJson(sdk, result);
      printVerboseStats(a, sdk);
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }
  const revokeId = flagValue(a, "--revoke");
  if (revokeId != null) {
    const target = await vaultTarget(a);
    try {
      const result = await sdk.gitvault.revokeInvite(revokeId, target);
      printJson(sdk, result);
      printVerboseStats(a, sdk);
    } catch (err) {
      reportSdkError(err);
    }
    return;
  }

  const note = await readInviteNoteInput(a);
  const ttlRaw = flagValue(a, "--ttl");
  const ttlSeconds = ttlRaw != null ? parseIntegerFlag("--ttl", ttlRaw, { min: 60, max: 86400 }) : undefined;
  const role = flagValue(a, "--role");
  const includeSensitive = flagValues(a, "--include-sensitive");
  const roomKey = flagValue(a, "--room");
  const target = await vaultTarget(a);
  // kygit-invite design D4/D8: the inviter's own presence carries
  // harness-derived labels and this checkout's resumable session identity —
  // never guessed.
  const { program, model } = resolveHarnessLabels();
  const { key: sessionKey } = resolveSessionKey();
  // The inviter's presence may RESUME an existing one by session key, and a
  // resumption refreshes `task` — so pass the harness's own thread title
  // (what `rooms join` / `messages send` already send), never a made-up
  // label that would overwrite what this session is actually working on.
  const { task } = await resolveTaskLabel({});

  const opts = {
    ...target,
    note,
    ...(role != null ? { role } : {}),
    ...(ttlSeconds != null ? { ttlSeconds } : {}),
    ...(includeSensitive.length > 0 ? { includeSensitive } : {}),
    ...(roomKey != null ? { roomKey } : {}),
    ...(program ? { program } : {}),
    ...(model ? { model } : {}),
    ...(task ? { task } : {}),
    sessionKey,
    onCommitLine: (line) => console.error(line),
  };
  try {
    const result = await sdk.gitvault.invite(opts);
    for (const w of result.warnings ?? []) {
      console.error(w.message ?? `${w.code}`);
    }
    console.error(`invite minted: role ${result.minted_role}, expires ${result.expires_at}, room ${result.room?.room_key ?? "(unknown)"}`);
    console.error(`recipient runs: kygit join <key printed below>`);
    if (result.inviter_presence && result.inviter_presence.registered === false) {
      console.error(`note: your own presence was not registered (${result.inviter_presence.error}) — the invite still mints and is claimable`);
    }
    if (result.room_fact && result.room_fact.posted === false) {
      console.error(`note: the room fact was not posted (${result.room_fact.reason}) — the invite still mints and remains claimable`);
    }
    // The inviter's own fact must not wake the inviter's next `messages wait`:
    // advance this checkout's stored cursor past it (best-effort).
    if (result.room?.room_key && result.room_fact?.posted && typeof result.room_fact.cursor === "string") {
      try { updateRoomState(result.room.organization_id, result.room.room_key, { cursor: result.room_fact.cursor }); } catch { /* never fails a mint */ }
    }
    if (asJson) {
      printJson(sdk, result);
    } else {
      // The key alone, so `KEY=$(run402 repos invite ...)` works — everything
      // else (the blast-radius warning, the commit line) is on stderr.
      console.log(result.invite_key);
    }
    printVerboseStats(a, sdk);
    void verbose;
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 repos join` — the full cold-start chain (SAME fold `resume`
 * uses), claim, restore exactly as `resume` does, pin `r402.room` to the
 * invite's OWN room, register this session's presence, post ONE arrival
 * fact, and report the inviter by name and labels, live presences, the
 * catch-up cursor, and the last few messages (kygit-invite design D5).
 */
async function joinInvite(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...JOIN_VALUE_FLAGS, "--key-stdin", "--no-init", "--json", "-v", "--verbose", "--help", "-h"], JOIN_VALUE_FLAGS);
  const sdk = getSdk();
  const keyStdin = a.includes("--key-stdin");
  const to = flagValue(a, "--to");
  const positionals = requirePositionalCount(a, [...JOIN_VALUE_FLAGS], { min: keyStdin ? 0 : 1, max: keyStdin ? 0 : 1, command: "run402 repos join <kgi1_…|--key-stdin>", missing: "Missing the Invite Key (positional argument, or --key-stdin)." });
  let key = positionals[0] ?? null;
  if (keyStdin) {
    key = (await readStdinText()).trim();
    if (!key) fail({ code: "BAD_USAGE", message: "Missing the Invite Key on stdin.", hint: "Pipe the kgi1_… key, or pass it as a positional argument." });
  }
  // kygit-invite design D5: a joined agent is a NEW run402 wallet, so `join`
  // folds the SAME cold-start chain `resume` does (allowance → faucet → one
  // x402 prototype payment, announced) BEFORE the claim; the claim itself
  // needs no tier, so the chain never blocks the claim. `--no-init` opts
  // out entirely.
  const coldStart = a.includes("--no-init") ? { performed: false, skipped: "no_init" } : await foldColdStartForResume(sdk);
  const { program, model } = resolveHarnessLabels();
  const { key: sessionKey, source: sessionKeySource } = resolveSessionKey();
  const { task } = await resolveTaskLabel({});
  try {
    const result = await sdk.gitvault.join({
      key,
      ...(to != null ? { to } : {}),
      ...(program ? { program } : {}),
      ...(model ? { model } : {}),
      ...(task ? { task } : {}),
      sessionKey,
      onLine: (line) => console.error(line),
    });
    if (coldStart.next_action) result.next_actions = [...(result.next_actions ?? []), coldStart.next_action];
    // kygit-invite design D5: the joined checkout's FIRST `messages wait`
    // must speak as the session that joined and read from the arrival
    // cursor — so the per-checkout room state (presence + cursor) is written
    // into the CLONE, not this cwd, along with the generated session key
    // when that is what identified this session (a harness-provided id is
    // found in the environment first, wherever the next command runs).
    // Best-effort: the join already succeeded; `.run402/` is excluded from
    // git in the clone by the SDK, so this never shows in `git status`.
    try {
      const dir = result.restored?.dir;
      if (dir && existsSync(dir)) {
        updateRoomState(result.room.organization_id, result.room.room_key, {
          ...(result.presence ? { presence_id: result.presence.presence_id, name: result.presence.name } : {}),
          ...(typeof result.cursor === "string" ? { cursor: result.cursor } : {}),
        }, { cwd: dir });
        if (sessionKeySource === "generated" || sessionKeySource === "generated_cached") persistSessionKey(dir, sessionKey);
      }
    } catch {
      // never fails a completed join
    }
    if (a.includes("--json")) {
      printJson(sdk, { ...result, cold_start: coldStart });
    } else {
      const rendered = renderInviteNoteMarkdown(result.note) ?? result.note_raw;
      if (rendered) {
        console.log(rendered);
      }
      console.error("");
      console.error(`joined into ${result.restored.dir} (branch ${result.restored.branch})`);
      if (result.deduplicated) console.error("note: this key was already claimed by this same principal — the ORIGINAL envelope was reused (safe replay)");
      // gitvault-multi-writer (rev 47) / kygit-invite design D5 — this
      // checkout's own writer activation, printed in the SAME `writer: …`
      // shape `resume` uses. `pending` is D9's not-stranded path: the key is
      // a pending writer, and the `request_writer_sync` next action below
      // names the remedy.
      if (result.writer_activation) {
        console.error(
          result.writer_activation.outcome === "active"
            ? `writer: active (generation ${result.writer_activation.generation})`
            : `writer: pending — ${result.writer_activation.reason}`,
        );
      }
      if (!result.presence) {
        console.error(`note: your own presence was not registered (${result.presence_failure ?? "unknown"}) — the arrival fact was not posted; your first \`run402 messages wait\` registers one`);
      }
      if (result.inviter) {
        const labels = [result.inviter.program, result.inviter.model].filter(Boolean).join("/");
        const liveness = result.inviter.state === "active" ? "live" : result.inviter.state;
        console.error(`invited by ${result.inviter.name}${labels ? ` (${labels})` : ""} — ${liveness}`);
      } else {
        console.error("invited by: unknown (the inviter never registered a presence)");
      }
      const others = (result.live_presences ?? []).filter((p) => !result.inviter || p.presence_id !== result.inviter.presence_id);
      if (others.length > 0) console.error(`also live: ${others.map((p) => p.name).join(", ")}`);
      const recent = result.recent_messages ?? [];
      if (recent.length > 0) {
        console.error(`recent messages (${recent.length}):`);
        for (const m of recent.slice().reverse()) {
          console.error(`  ${m.sender ?? "?"}: ${m.body_snippet ?? m.body ?? ""}`);
        }
      }
      for (const na of result.next_actions ?? []) {
        if (na.command) console.error(`next: ${na.command}${na.why ? ` — ${na.why}` : ""}`);
      }
    }
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── policy ─────────────────────────────────────────────────────────────────

/**
 * gitvault-checkpoint-cadence design D1: `auto-gc` is a LOCAL, per-checkout
 * knob — the same local-git-config mechanism as the restore marker, and the
 * same shape as git's own `gc.auto` — deliberately NOT a gateway call like
 * `required`/`grandfathered` above (there is no server-side policy row for
 * it; the gateway task list for this change never adds one). It rides
 * `repos policy`'s NAMESPACE only, for the muscle-memory: `run402 repos
 * policy auto-gc [<generations>|off]`. No value reads the current setting;
 * `off` is sugar for `0` (disables auto-gc entirely).
 */
async function policyAutoGc(rawValue, a) {
  const { hardenedGit, readGitvaultAutoGcThreshold, writeGitvaultAutoGcThreshold, GITVAULT_AUTO_GC_GENERATIONS_DEFAULT } = await import("#sdk/node");
  const dir = process.cwd();
  try {
    await hardenedGit(dir, ["rev-parse", "--git-dir"]);
  } catch {
    fail({
      code: "BAD_USAGE",
      message: "run402 repos policy auto-gc must run inside a git checkout.",
      hint: "cd into the repository this vault is checked out in, then re-run — auto-gc's threshold is per-checkout, like git's own `gc.auto`.",
    });
  }
  const sdk = getSdk();
  if (rawValue === undefined) {
    const current = await readGitvaultAutoGcThreshold(dir);
    printJson(sdk, { auto_gc_generations: current, default: GITVAULT_AUTO_GC_GENERATIONS_DEFAULT });
    console.error(
      current === 0
        ? "auto-gc is disabled for this checkout"
        : `auto-gc runs after a push once ${current} generation(s) have accumulated since the last checkpoint (default ${GITVAULT_AUTO_GC_GENERATIONS_DEFAULT})`,
    );
    printVerboseStats(a, sdk);
    return;
  }
  let generations;
  if (rawValue === "off") {
    generations = 0;
  } else if (/^\d+$/.test(rawValue)) {
    generations = Number.parseInt(rawValue, 10);
  } else {
    fail({
      code: "BAD_USAGE",
      message: `Invalid auto-gc value: ${rawValue}.`,
      hint: "Expected a non-negative integer (generations since checkpoint before auto-gc runs), or `off` to disable.",
      details: { value: rawValue },
    });
  }
  await writeGitvaultAutoGcThreshold(dir, generations);
  printJson(sdk, { auto_gc_generations: generations });
  console.error(
    generations === 0
      ? "auto-gc disabled for this checkout"
      : `auto-gc will run after a push once ${generations} generation(s) have accumulated since the last checkpoint`,
  );
  printVerboseStats(a, sdk);
}

async function policy(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--reason"];
  assertKnownFlags(a, [...valueFlags, "-v", "--verbose", "--help", "-h"], valueFlags);
  const positionals = requirePositionalCount(a, valueFlags, {
    min: 1, max: 2, command: "run402 repos policy <required|grandfathered|auto-gc> [value]",
    missing: "Missing <policy>. Expected `required`, `grandfathered`, or `auto-gc [<generations>|off]`.",
  });
  const [requested, secondArg] = positionals;
  if (requested === "auto-gc") {
    return policyAutoGc(secondArg, a);
  }
  if (secondArg !== undefined) {
    fail({ code: "BAD_USAGE", message: `Unexpected argument for run402 repos policy ${requested}: ${secondArg}`, hint: "Only `auto-gc` takes a second argument." });
  }
  if (requested !== "required" && requested !== "grandfathered") {
    fail({
      code: "BAD_USAGE",
      message: `Unknown policy: ${requested}.`,
      hint: "Expected `required` (a deploy must present a vaulted capture), `grandfathered` (it need not), or `auto-gc [<generations>|off]` (the post-push compaction cadence).",
      details: { policy: requested, known_policies: ["required", "grandfathered", "auto-gc"] },
    });
  }
  const reason = flagValue(a, "--reason");
  if (requested === "grandfathered" && (reason == null || reason.trim() === "")) {
    fail({
      code: "BAD_USAGE",
      message: "`grandfathered` needs --reason <why>.",
      hint: "It weakens the activation guarantee for this project and is recorded in the audit event. Say why, e.g. --reason \"migrating CI to a vaulted client\".",
      details: { policy: requested },
    });
  }

  const target = await vaultTarget(a);
  try {
    const sdk = getSdk();
    const repoId = target.repo_id ?? (await sdk.gitvault.forProject(target.project_id)).repo_id;
    const result = await sdk.gitvault.setPolicy(repoId, { gitvault_policy: requested, ...(reason != null ? { reason } : {}) });
    printJson(sdk, { repo_id: repoId, ...result });
    console.error(
      result.changed
        ? `gitvault_policy is now ${result.gitvault_policy} (version ${result.gitvault_policy_version})`
        : `gitvault_policy was already ${result.gitvault_policy} — nothing changed`,
    );
    for (const w of result.warnings ?? []) console.error(`warning (${w.kind}): ${w.message}`);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── mirror (ONE flag-driven verb) ─────────────────────────────

const MIRROR_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--profile", "--region", "--endpoint"];

async function mirrorRead(target, a) {
  const sdk = getSdk();
  try {
    const result = await sdk.gitvault.mirrorStatus(target);
    printJson(sdk, result);
    if (!result.configured) {
      console.error(`no mirror configured for ${result.repo_id}. Configure one: run402 repos mirror <destination>`);
    } else {
      const currency = result.is_current === true ? "current" : result.is_current === false ? `STALE — ${result.closing_command}` : "unknown (mirror unreachable or vault unread)";
      console.error(`mirror ${result.destination}: mirrored generation ${result.mirrored_generation ?? "(none)"}, vault newest ${result.newest_generation ?? "(none)"} — ${currency}`);
    }
    printMirrorHonesty(result);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorSet(target, destination, a) {
  const sdk = getSdk();
  const credential = resolveMirrorCredential(a);
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  try {
    const result = await sdk.gitvault.mirrorSet({
      ...target,
      destination_url: destination,
      ...(credential ? { credential } : {}),
      ...(region != null ? { region } : {}),
      ...(endpoint != null ? { endpoint } : {}),
    });
    printJson(sdk, result);
    console.error(`mirror configured for ${result.repo_id} -> ${formatMirrorDestination(result.destination)}`);
    console.error("run `run402 repos mirror --backfill` to catch it up now, then every publish dual-pushes automatically.");
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorOff(target, a) {
  const sdk = getSdk();
  try {
    const result = await sdk.gitvault.mirrorRemove(target);
    printJson(sdk, result);
    console.error(
      result.removed
        ? `mirror config removed for ${result.repo_id} — the mirror's OWN bytes were not touched`
        : `no mirror was configured for ${result.repo_id} — nothing to remove`,
    );
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirrorBackfill(target, a) {
  const sdk = getSdk();
  try {
    const result = await sdk.gitvault.mirrorSync(target);
    printJson(sdk, result);
    await spillIfLarge(result.repo_id, "mirror-backfill", result);
    console.error(
      `mirror backfill for ${result.repo_id}: ${result.objects_copied} copied, ${result.objects_already_present} already present` +
      `${result.objects_skipped_foreign_recipient > 0 ? `, ${result.objects_skipped_foreign_recipient} skipped (envelopes for other recipients — expected)` : ""}` +
      `${result.objects_failed > 0 ? `, ${result.objects_failed} FAILED` : ""} (${result.bytes_copied} byte(s) copied this run).`,
    );
    for (const e of result.errors) console.error(`  failed: ${e.key} — ${e.error}`);
    printMirrorHonesty(result);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function mirror(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...MIRROR_VALUE_FLAGS, "--off", "--backfill", "--ambient", "-v", "--verbose", "--help", "-h"], MIRROR_VALUE_FLAGS);
  const positionals = requirePositionalCount(a, MIRROR_VALUE_FLAGS, {
    min: 0, max: 1, command: "run402 repos mirror [<destination>]", missing: "",
  });
  const destination = positionals[0] ?? null;
  const off = a.includes("--off");
  const backfill = a.includes("--backfill");
  const modeCount = [destination != null, off, backfill].filter(Boolean).length;
  if (modeCount > 1) {
    fail({
      code: "BAD_USAGE",
      message: "pass at most one of: <destination>, --off, --backfill.",
      hint: "run402 repos mirror (read) | run402 repos mirror <destination> (configure) | run402 repos mirror --off (remove) | run402 repos mirror --backfill (catch up)",
    });
  }
  const target = await vaultTarget(a);
  if (destination != null) return mirrorSet(target, destination, a);
  if (off) return mirrorOff(target, a);
  if (backfill) return mirrorBackfill(target, a);
  return mirrorRead(target, a);
}

// ─── fsck (verify the head chain + materialize refs) ──────────────────

/**
 * D210 (rev 44): one line describing `fsck`'s best-effort proof-of-open
 * submission outcome — never blank, so a reader always knows whether
 * `open_proof` is silence (audit mode / no local identity) or a real
 * attempt (submitted, or a caught failure). Shared by `--human` and the
 * default JSON-mode stderr summary.
 */
function formatOpenProofLine(openProof) {
  if (!openProof || !openProof.attempted) return null;
  if (openProof.submitted) {
    return `proof-of-open: ${openProof.deduplicated ? "already on file" : "submitted"} (${openProof.receipt.object_id}, decryptable through ${openProof.receipt.decryptable_to_generation}).`;
  }
  return `proof-of-open: not submitted — ${openProof.error.code}: ${openProof.error.message}`;
}

/**
 * gitvault-byo-primary-bucket task 3.3: one line reporting `fsck`'s BYO
 * presence check — always present for a BYO vault (never blank), absent for
 * a managed one (`result.byo_presence` is `undefined` there, so this
 * returns `null` and no line prints — zero output change for managed
 * vaults). A MISSING-object verdict never reaches here: it throws
 * `GITVAULT_BYO_OBJECT_MISSING` before `fsck` returns a result at all, so
 * this line only ever reports the two non-failure outcomes — checked-clean
 * or explicitly not-checked. Shared by `--human` and the default JSON-mode
 * stderr summary, same convention as `formatOpenProofLine` above.
 */
function formatByoPresenceLine(byoPresence) {
  if (!byoPresence) return null;
  if (!byoPresence.verified) {
    return `BYO storage: NOT CHECKED — ${byoPresence.not_checked_reason}`;
  }
  return `BYO storage: verified ${byoPresence.checked_count} object(s) present at ${byoPresence.destination}.`;
}

/** `repos fsck --human`: the same verdict the stderr lines already carry, condensed into one block. */
function formatFsckHuman(result, mirrorRequested) {
  const lines = [`Repo: ${result.repo_id}`];
  lines.push(
    !result.write
      ? `Verified through generation ${result.verified_to_generation} — audit mode, nothing local was persisted.`
      : result.local_state_changed
        ? `Verified through generation ${result.verified_to_generation} — local pin advanced from ${result.pin_before.highest_authenticated ?? "genesis"} to ${result.pin_after.highest_authenticated}.`
        : `Verified through generation ${result.verified_to_generation} — already at the newest verified generation.`,
  );
  // Request 1 (D193-D203, rev 42): chain-verified and decryptable can
  // genuinely differ across an epoch rotation this keystore cannot open —
  // never silently report "verified" for a generation restoration cannot
  // decrypt.
  if (result.decryptable_to_generation !== result.chain_verified_to_generation) {
    lines.push(
      `WARNING: chain verified to generation ${result.chain_verified_to_generation}, but only decryptable through ${result.decryptable_to_generation}` +
        (result.epoch_decrypt_failure
          ? ` — epoch ${result.epoch_decrypt_failure.epoch} (rotation ${result.epoch_decrypt_failure.rotation_id ?? "n/a"}) could not be opened by this keystore: ${result.epoch_decrypt_failure.code}.`
          : "."),
    );
  }
  if (mirrorRequested && result.mirror) {
    lines.push(
      `Mirror: recoverable generation ${result.mirror.recovered_generation}` +
      (result.mirror.chain_break ? ` (chain break at ${result.mirror.chain_break.generation}: ${result.mirror.chain_break.reason})` : "") +
      (result.mirror.data_loss_detected ? ` — DATA LOSS DETECTED (${result.mirror.absences.filter((x) => x.adjudication === "unexplained_absence").length} unexplained absence(s))` : ""),
    );
  }
  if (result.retained_refs?.warning) {
    lines.push(`refs/r402/retain: ${result.retained_refs.warning}`);
  } else if (result.retained_refs) {
    lines.push(`refs/r402/retain: ${result.retained_refs.retained_count} retained tip(s) referenced (+${result.retained_refs.written.length} -${result.retained_refs.deleted.length} this run).`);
  }
  const openProofLine = formatOpenProofLine(result.open_proof);
  if (openProofLine) lines.push(openProofLine);
  const byoPresenceLine = formatByoPresenceLine(result.byo_presence);
  if (byoPresenceLine) lines.push(byoPresenceLine);
  return lines.join("\n");
}

async function fsck(args) {
  const a = normalizeArgv(args);
  const valueFlags = [...COMMON_VALUE_FLAGS, "--budget"];
  assertKnownFlags(a, [...valueFlags, "--mirror", "--no-write", "--human", "-v", "--verbose", "--help", "-h"], valueFlags);
  requirePositionalCount(a, valueFlags, { min: 0, max: 0, command: "run402 repos fsck", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  const budget = flagValue(a, "--budget");
  if (budget != null) target.verification_budget = parseIntegerFlag("--budget", budget, { min: 1 });
  const write = !a.includes("--no-write");
  const mirrorRequested = a.includes("--mirror");
  try {
    const result = await sdk.gitvault.fsck({ ...target, write, mirror: mirrorRequested });
    if (human) {
      console.log(formatFsckHuman(result, mirrorRequested));
      if (mirrorRequested && result.mirror) printMirrorHonesty(result.mirror);
      printVerboseStats(a, sdk);
      return;
    }
    printJson(sdk, result);
    await spillIfLarge(result.repo_id, "fsck", result);
    if (!write) {
      console.error(`--no-write: verified through generation ${result.verified_to_generation} — nothing local was persisted (pin_before === pin_after).`);
    } else if (result.local_state_changed) {
      console.error(`verified through generation ${result.verified_to_generation} — local pin advanced from ${result.pin_before.highest_authenticated ?? "genesis"} to ${result.pin_after.highest_authenticated}.`);
    } else {
      console.error(`verified through generation ${result.verified_to_generation} — already at the newest verified generation, nothing changed.`);
    }
    // Request 1: surface the chain-verified vs decryptable split whenever it differs — the incident's own honesty gap (fsck claiming "verified" for content restoration cannot decrypt).
    if (result.decryptable_to_generation !== result.chain_verified_to_generation) {
      console.error(
        `WARNING: chain verified to generation ${result.chain_verified_to_generation}, but only decryptable through ${result.decryptable_to_generation}` +
          (result.epoch_decrypt_failure
            ? ` — epoch ${result.epoch_decrypt_failure.epoch} (rotation ${result.epoch_decrypt_failure.rotation_id ?? "n/a"}) could not be opened by this keystore: ${result.epoch_decrypt_failure.code}.`
            : "."),
      );
    }
    // clone-installs-retained-refs D3: a bookkeeping failure degrades to
    // exactly one stderr note here — fsck's own result already landed above.
    if (result.retained_refs?.warning) {
      console.error(`repos fsck: ${result.retained_refs.warning}`);
    } else if (result.retained_refs && (result.retained_refs.written.length > 0 || result.retained_refs.deleted.length > 0)) {
      console.error(`refs/r402/retain: +${result.retained_refs.written.length} -${result.retained_refs.deleted.length} (${result.retained_refs.retained_count} retained tip(s) total).`);
    }
    // D210 (rev 44): the best-effort proof-of-open submission's own outcome
    // — informational only, printed regardless of whether it succeeded (a
    // failure here is exactly as uninteresting to this command's own exit
    // status as a mirror probe's failure would be).
    const openProofLine = formatOpenProofLine(result.open_proof);
    if (openProofLine) console.error(openProofLine);
    // gitvault-byo-primary-bucket task 3.3: absent (formats to `null`) for a
    // managed vault — `result.byo_presence` is `undefined` there, so this
    // line never prints and JSON-mode output for a managed vault is
    // unchanged. A missing-object verdict never reaches this line at all —
    // it throws `GITVAULT_BYO_OBJECT_MISSING` before `fsck` returns, caught
    // by this function's own `reportSdkError(err)` below.
    const byoPresenceLine = formatByoPresenceLine(result.byo_presence);
    if (byoPresenceLine) console.error(byoPresenceLine);
    if (mirrorRequested && result.mirror) {
      console.error(`mirror: recoverable generation ${result.mirror.recovered_generation}${result.mirror.chain_break ? ` (chain break at ${result.mirror.chain_break.generation}: ${result.mirror.chain_break.reason})` : ""}.`);
      if (result.mirror.data_loss_detected) {
        console.error(`DATA LOSS DETECTED: ${result.mirror.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences.`);
      }
      // gitvault-recovery-custody: member recovery-bundle sidecars, reported
      // as UNVERIFIED availability hints — nothing about them is chain-
      // authenticated; they only say bundle + source recovery code can
      // recover this mirror with no server.
      if (Array.isArray(result.mirror.member_recovery_bundles) && result.mirror.member_recovery_bundles.length > 0) {
        for (const b of result.mirror.member_recovery_bundles) {
          console.error(
            b.parse_error
              ? `member recovery bundle (unverified hint): ${b.key} — does not parse (${b.parse_error})`
              : `member recovery bundle (unverified hint): ${b.key} — ${b.ek_fingerprint} [${b.wrapper_kinds.join(", ")}]; recover with \`run402 repos recover <source> --receipt <pin.json>\` + the source recovery code`,
          );
        }
      }
      printMirrorHonesty(result.mirror);
    }
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── gc (checkpoint + prune) ──────────────────────────────

const GC_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--intent-core", "--verifier-receipt"];

/**
 * One line of headroom disclosure. Printed whether or not things fit: an
 * operator deciding when to compact wants the numbers in the passing case too
 * (gitvault-compaction-headroom-preflight D4).
 */
function printHeadroomNote(headroom) {
  if (!headroom) return;
  const mib = (n) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  const verdict = headroom.overridden
    ? "OVER the pooled cap — proceeding because --force-headroom was passed; the platform's own quota stays authoritative"
    : headroom.ok
      ? "fits"
      : "does NOT fit";
  console.error(
    `storage headroom: ${mib(headroom.pool_used_bytes)} used of ${mib(headroom.pool_limit_bytes)} pooled; ` +
    `compaction transiently adds about ${mib(headroom.vault_source_bytes)} (it holds both the new checkpoint and the ` +
    `not-yet-pruned history until a prune completes) — projected ${mib(headroom.projected_transient_bytes)}, ${verdict}.`,
  );
}

async function gc(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...GC_VALUE_FLAGS, "--submit", "--wait", "--force-headroom", "-v", "--verbose", "--help", "-h"], GC_VALUE_FLAGS);
  requirePositionalCount(a, GC_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos gc", missing: "" });
  const sdk = getSdk();
  const submitting = a.includes("--submit");
  const corePath = flagValue(a, "--intent-core");
  const receiptPath = flagValue(a, "--verifier-receipt");
  if (submitting && (corePath == null || receiptPath == null)) {
    fail({
      code: "BAD_USAGE",
      message: "run402 repos gc --submit needs both --intent-core and --verifier-receipt.",
      hint: "Plan first (`run402 repos gc`), save prune.intent_core, run r402s-verify (prebuilt release binaries) against it, then submit both.",
    });
  }
  if (!submitting && (corePath != null || receiptPath != null)) {
    fail({ code: "BAD_USAGE", message: "--intent-core / --verifier-receipt only apply with --submit.", hint: "Add --submit, or drop the flags to plan." });
  }
  const target = await vaultTarget(a);
  // gitvault-client-round-trips design D3 (task 4.2): re-apply the local
  // object cache's eviction window as a periodic backstop. Best-effort —
  // a sweep failure must never block the actual gc plan/submit.
  try {
    await sdk.gitvault.sweepObjectCache(target);
  } catch {
    // never let cache housekeeping fail a real gc operation
  }

  try {
    if (submitting) {
      const opts = { ...target, submit: { core: readJsonFile("--intent-core", corePath), verifier_receipt: readJsonFile("--verifier-receipt", receiptPath) } };
      if (a.includes("--wait")) opts.submit.wait = {};
      const prune = await sdk.gitvault.prune(opts);
      // No compaction runs on this half, so the figures come from the
      // standalone read — disclosed anyway, because "how close is this org to
      // its pooled cap" is exactly as worth knowing while reclaiming storage.
      const headroom = await sdk.gitvault.compactHeadroom(target).catch(() => null);
      const out = { phase: "submitted", prune, headroom };
      printJson(sdk, out);
      if (prune.confirmation?.outcome) {
        console.error(
          `submitted — the signed completion reports ${prune.confirmation.deleted.length} deleted, ` +
          `${prune.confirmation.present.length} still present` +
          `${prune.confirmation.unadjudicated.length > 0 ? `, ${prune.confirmation.unadjudicated.length} unadjudicated` : ""}.`,
        );
      } else {
        console.error("submitted — no completion yet. Nothing is deleted until the control-plane-signed completion says so; re-run with --wait or poll the intent.");
      }
      console.error(prune.note);
      printHeadroomNote(headroom);
      printVerboseStats(a, sdk);
      return;
    }

    const checkpoint = await sdk.gitvault.compact({ ...target, ...(a.includes("--force-headroom") ? { ignoreHeadroom: true } : {}) });
    const prune = await sdk.gitvault.prune(target);
    const nextActions = [];
    if (!prune.blocked_reason && prune.object_candidates.length > 0) {
      // Additive fields beyond the CLI's usual {type, command, why}: the
      // `gc` is never described as "exactly git gc," and its submit
      // next_action must say so structurally, not just in prose.
      nextActions.push({
        type: "submit_gc",
        command: "run402 repos gc --submit --intent-core <core.json> --verifier-receipt <receipt.json>",
        why: "Submit the signed prune intent after independent verification with r402s-verify.",
        safe_to_auto_execute: false,
        requires_approval: true,
        destructive: true,
      });
    }
    const out = { phase: "planned", checkpoint, prune, headroom: checkpoint.headroom ?? null, next_actions: nextActions };
    printJson(sdk, out);
    console.error(`checkpoint published at generation ${checkpoint.generation}: ${checkpoint.covered_refs} ref(s), ${checkpoint.covered_roots} retention root(s).`);
    printHeadroomNote(checkpoint.headroom);
    if (!checkpoint.cutoff_bound) {
      console.error("no retention-cutoff ticket was obtained, so roots were RETAINED — expiry is permissive. The checkpoint published, but no expired root left the map.");
    }
    if (prune.blocked_reason) {
      console.error(`prune: nothing to submit — ${prune.blocked_reason}`);
    } else {
      console.error(
        `prune: ${prune.object_candidates.length} object(s) proposed for deletion` +
        `${prune.deferred_object_count > 0 ? ` (${prune.deferred_object_count} more deferred to a later intent)` : ""}` +
        `; ${prune.eligible_count} retention root(s) past their window, ${prune.retained_count} retained.`,
      );
      if (prune.intent_core_sha256) {
        console.error(`intent_core_sha256: ${prune.intent_core_sha256} — run r402s-verify (ships as prebuilt release binaries) against this core, then re-run with --submit.`);
      }
    }
    console.error("`gc` is NOT \"exactly git gc\" — the deletion ceremony is stricter: nothing is removed until a control-plane-signed completion confirms it.");
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── access (read-only; repair gated) ──────────────────────

/** `repos access --human`: a compact roster of directory recipients and their coverage. */
function formatAccessHuman(result) {
  const lines = [`Repo: ${result.repo_id}`];
  lines.push(`Recipients: ${result.recipients.length} directory, ${result.recipients.filter((r) => r.covered).length} covered`);
  for (const r of result.recipients) {
    lines.push(`  ${r.covered ? "covered" : "NOT covered"}  ${r.display_name ?? r.principal_id}${r.envelope_state ? ` (${r.envelope_state})` : ""}`);
  }
  if (result.this_keystore) lines.push(`This machine's own keystore also covers (writing principal, not in org directory): ${result.this_keystore.fingerprint}`);
  if (result.unmatched_covered_fingerprints.length > 0) lines.push(`Orphaned/external coverage: ${result.unmatched_covered_fingerprints.join(", ")}`);
  if (Array.isArray(result.stale_access) && result.stale_access.length > 0) {
    lines.push(`Stale access (removed members that still decrypt): ${result.stale_access.map((s) => s.display_name ?? s.principal_id).join(", ")}`);
  }
  lines.push(result.gap);
  return lines.join("\n");
}

/** One stderr line for the access read's "you" block — your own wrapper custody, or the honest reason it is absent. */
function printMemberCustodySummary(mc) {
  if (!mc) return;
  if (!mc.available) {
    console.error(`you: (not included — ${mc.reason}) ${mc.hint}`);
    return;
  }
  if (!mc.encryption_key_id) {
    console.error(`you: ${mc.hint}`);
    return;
  }
  const active = mc.wrappers.filter((w) => w.state === "active");
  const pending = mc.wrappers.filter((w) => w.state === "pending");
  console.error(
    `you: ${mc.ek_fingerprint} (${mc.custody_scheme}, ${mc.state}) — ${active.length} active wrapper(s) [${active.map((w) => w.kind).join(", ") || "none"}]` +
      (pending.length > 0 ? `, ${pending.length} pending (unfinished enrollment — finish or it expires)` : "") + ".",
  );
  if (active.length > 0 && !active.some((w) => w.kind === "recovery_code")) {
    console.error("you: no recovery_code wrapper — a passkey-only key has no offline/no-server recovery path; add one at console.run402.com/account.");
  }
}

async function accessRead(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--human", "--no-reconcile", "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.access({ ...target, ...(a.includes("--no-reconcile") ? { reconcile: "deferred" } : {}) });
    // gitvault-recovery-custody — the "you" block: YOUR OWN wrapper custody
    // (kind/state per wrapper, custody scheme), rendered inside the family's
    // custody roster read. Principal-scoped, so it needs your control-plane
    // (human) session; without one it is honestly absent-with-reason rather
    // than silently missing or misleadingly answered as the agent principal.
    // Best-effort: an older gateway or a failed read never breaks `access`.
    const cp = loadLiveControlPlaneSession();
    if (cp) {
      try {
        const mine = await sdk.operator.session.sourceAccessWrappers({ token: cp.control_plane_session_token });
        result.member_custody = mine.encryption_key
          ? {
              available: true,
              encryption_key_id: mine.encryption_key.encryption_key_id,
              ek_fingerprint: mine.encryption_key.ek_fingerprint,
              custody_scheme: mine.encryption_key.custody_scheme,
              state: mine.encryption_key.state,
              wrappers: mine.wrappers.map((w) => ({ wrapper_id: w.wrapper_id, kind: w.kind, state: w.state, created_at: w.created_at, activated_at: w.activated_at })),
            }
          : { available: true, encryption_key_id: null, hint: "no source-access key enrolled — enroll at console.run402.com/account → Source access." };
      } catch (e) {
        result.member_custody = { available: false, reason: e?.code ?? "read_failed", hint: "your own wrapper custody could not be read (older gateway, or the session lacks it)." };
      }
    } else {
      result.member_custody = { available: false, reason: "no_control_plane_session", hint: "run 'run402 operator login --loopback' to include your own wrapper custody here." };
    }
    if (human) {
      console.log(formatAccessHuman(result));
      printMemberCustodySummary(result.member_custody);
      printVerboseStats(a, sdk);
      return;
    }
    printJson(sdk, result);
    await spillIfLarge(result.repo_id, "access", result);
    console.error(`${result.recipients.length} directory recipient(s), ${result.recipients.filter((r) => r.covered).length} covered on this repo.`);
    printMemberCustodySummary(result.member_custody);
    if (result.this_keystore) {
      console.error(`1 covering fingerprint is this machine's own keystore (the vault's writing principal, not in the org directory): ${result.this_keystore.fingerprint}`);
    }
    if (result.unmatched_covered_fingerprints.length > 0) {
      console.error(`${result.unmatched_covered_fingerprints.length} covering fingerprint(s) match no directory entry or desired-state row (orphaned/external): ${result.unmatched_covered_fingerprints.join(", ")}`);
    }
    if (Array.isArray(result.stale_access) && result.stale_access.length > 0) {
      const names = result.stale_access.map((s) => s.display_name ?? s.principal_id).join(", ");
      console.error(`${result.stale_access.length} removed member(s) STILL decrypt this vault (not yet revocable — no epoch rotation in v0): ${names}`);
    }
    console.error(result.gap);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

const ROTATION_VALUE_FLAGS = [...COMMON_VALUE_FLAGS, "--recipient-state-version", "--recipient-revocation-version", "--idempotency-key"];

/**
 * `run402 repos access repair` (D193-D203, rev 42) — a general re-key of
 * this vault's CURRENT epoch, dropping every principal in `stale_access`
 * (`pending_removal`, still covered) and clearing a pre-existing vault's
 * one-time migration requirement. Drives `rotateEpoch({reason:"elective_rekey"})`.
 *
 * `--recipient-state-version`/`--recipient-revocation-version` are the D194
 * frozen watermarks this attempt must be fenced against. They are NOT
 * discovered automatically here: the live gateway exposes NO general read
 * route for `internal.gitvault_recipient_state_counters` outside the
 * `key-revocation` declare route's own response (see
 * `GitvaultVault.rotateEpoch`'s doc comment, `sdk/src/node/gitvault-
 * publication.ts`, for the confirmed source-level finding). Until that
 * route ships, this verb needs the pair supplied explicitly — refusing
 * cleanly and naming exactly this when they are omitted, rather than
 * guessing and either failing opaquely or (worse) never converging.
 *
 * **`elective_rekey` refuses ANY exclusion** (`EPOCH_ROTATION_INCOMPLETE_ENROLLMENT`
 * on even one keyless/unconfirmed desired principal) — so a pending
 * `/confirm`/`/repin` receipt does NOT help here: folding it into THIS
 * rotation's `pending_confirmations` still leaves that principal
 * `excluded_unconfirmed` for THIS rotation (D196 — same-head manifest
 * updates never self-authorize), which `elective_rekey`'s own
 * completeness check then refuses on. If a directory principal is
 * unconfirmed when this vault needs to clear its migration requirement,
 * use `run402 repos access revoke-key`/`declare-exposure` instead (an
 * urgent reason, which admits with a nonempty partial target set) and
 * fold the pending receipt into THAT rotation.
 */
async function accessRepair(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...ROTATION_VALUE_FLAGS, "-v", "--verbose", "--help", "-h"], ROTATION_VALUE_FLAGS);
  requirePositionalCount(a, ROTATION_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access repair", missing: "" });
  const recipientStateVersion = flagValue(a, "--recipient-state-version");
  const recipientRevocationVersion = flagValue(a, "--recipient-revocation-version");
  if (recipientStateVersion == null || recipientRevocationVersion == null) {
    fail({
      code: "ROTATION_COUNTERS_REQUIRED",
      message: "`run402 repos access repair` needs --recipient-state-version and --recipient-revocation-version — the gateway does not yet expose a read route for these two counters outside the key-revocation declare route.",
      hint: "If you know a specific principal whose key should be revoked, use `run402 repos access revoke-key <principal_id>` instead — it is fully self-contained (no flags needed). `access repair` is the general re-key for clearing stale_access / a first-ever migration and needs these two values from platform staff or direct DB access until a gateway read route ships.",
      next_actions: [nextAction("edit_request", { command: "run402 repos access revoke-key <principal_id>", why: "the ONE fully self-contained rotation entry point today — no counters needed" })],
    });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.rotateEpoch({
      ...target,
      reason: "elective_rekey",
      recipient_state_version: recipientStateVersion,
      recipient_revocation_version: recipientRevocationVersion,
      ...(flagValue(a, "--idempotency-key") != null ? { client_idempotency_key: flagValue(a, "--idempotency-key") } : {}),
    });
    printJson(sdk, result);
    await spillIfLarge(result.rotation_id, "access-repair", result);
    console.error(`rotated to epoch ${result.new_epoch} at generation ${result.generation}: ${result.included.length} recipient(s) included, ${result.excluded_keyless_principal_ids.length} keyless, ${result.excluded_unconfirmed_principal_ids.length} unconfirmed.`);
    console.error(`self_check: ${result.self_check}${result.self_check === "not_a_recipient" ? " (this machine's own principal is not itself a vault recipient — nothing to self-verify)" : " (this machine's own opened envelope reproduced the committed epoch key)"}.`);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 repos access revoke-key <principal_id>` (D199) — the ONE fully
 * self-contained rotation entry point: declares
 * `reason:"recipient_key_revoked"` for `principal_id` (owner + step-up)
 * and drives the rotation off that declaration's OWN returned counters.
 * No flags needed — this is the reason value with a real, working
 * gateway-side counter read.
 */
async function accessRevokeKey(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--idempotency-key", "-v", "--verbose", "--help", "-h"], [...COMMON_VALUE_FLAGS, "--idempotency-key"]);
  const [principalId] = requirePositionalCount(a, [...COMMON_VALUE_FLAGS, "--idempotency-key"], {
    min: 1, max: 1, command: "run402 repos access revoke-key <principal_id>",
    missing: "Missing <principal_id>. This is the principal whose current key should no longer be trusted — the next rotation excludes them from the new epoch.",
  });
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.rotateEpochForKeyRevocation(principalId, {
      ...target,
      ...(flagValue(a, "--idempotency-key") != null ? { client_idempotency_key: flagValue(a, "--idempotency-key") } : {}),
    });
    printJson(sdk, result);
    await spillIfLarge(result.rotation_id, "access-revoke-key", result);
    console.error(`declared ${principalId}'s key revoked and rotated to epoch ${result.new_epoch} at generation ${result.generation}: ${result.included.length} recipient(s) included going forward.`);
    console.error(`self_check: ${result.self_check}.`);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

/**
 * `run402 repos access declare-exposure` (D199) — declares
 * `reason:"epoch_secret_exposed"` admissible for THIS vault (owner +
 * step-up), vault-scoped (one vault's leaked key is not evidence any
 * sibling vault is compromised). The DECLARATION itself is real and
 * self-contained; the FOLLOW-UP rotation it authorizes is NOT auto-run
 * here, because — same confirmed gap as `access repair` — the D194
 * counters it must be fenced against have no client-visible read for this
 * reason value either. This is the rekey remedy for an exposed key:
 * declare here, then rotate (via `--recipient-state-version`/
 * `--recipient-revocation-version` once known, e.g. from platform staff).
 *
 * **If a `/confirm`/`/repin` receipt is already pending** (a directory
 * principal was confirmed BEFORE this declaration, or gets confirmed while
 * the rotation is outstanding), do NOT call `publishPinManifestUpdate`
 * separately — that call is itself an ORDINARY admission and is itself
 * refused `EPOCH_ROTATION_REQUIRED` for as long as this declaration stays
 * outstanding. Pass the receipt
 * to `r.gitvault.rotateEpoch({..., pending_confirmations: [{principal_id,
 * ek_fingerprint, receipt}]})` instead — it rides the SAME head as the
 * rotation this declaration requires, publishing durably without needing a
 * second, separately-gated admission. See `GitvaultVault.rotateEpoch`'s
 * doc comment for what this does NOT do: the folded principal is still
 * excluded from THIS rotation's own envelope set (D196) and becomes
 * eligible starting at the NEXT rotation.
 */
/**
 * `repos access repin --principal <id> --fingerprint <ek_…>` — a KEY-HOLDER
 * explicitly accepts a recipient's CHANGED key (gitvault-agent-envelopes D3).
 * The session-start reconcile refuses `pinned_key_mismatch` and never
 * bypasses it, not even after an owner's revoke — acceptance names the new
 * fingerprint (the out-of-band verification point) and moves the local pin.
 * Adapter only: `sdk.gitvault.acceptRecipientKeyChange`.
 */
async function accessRepin(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--principal", "--fingerprint", "--help", "-h"], [...COMMON_VALUE_FLAGS, "--principal", "--fingerprint"]);
  requirePositionalCount(a, [...COMMON_VALUE_FLAGS, "--principal", "--fingerprint"], { min: 0, max: 0, command: "run402 repos access repin --principal <principal_id> --fingerprint <ek_fingerprint>", missing: "" });
  const principalId = flagValue(a, "--principal");
  const fingerprint = flagValue(a, "--fingerprint");
  if (!principalId || !fingerprint) {
    fail({ code: "BAD_USAGE", message: "repin needs --principal <principal_id> and --fingerprint <ek_fingerprint> (read the fingerprint back with the recipient — it is public data).", hint: "run402 repos access repin --principal <principal_id> --fingerprint <ek_fingerprint>" });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.acceptRecipientKeyChange({ ...target, principal_id: principalId, new_fingerprint: fingerprint });
    console.log(JSON.stringify({ ...result, next_actions: [{ type: "retry", command: "run402 repos view", why: "the next ordinary gitvault operation on this machine wraps the vault to the accepted key" }] }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function accessDeclareExposure(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access declare-exposure", missing: "" });
  const target = await vaultTarget(a);
  try {
    const sdk = getSdk();
    const repoId = target.repo_id ?? (await sdk.gitvault.forProject(target.project_id)).repo_id;
    const result = await sdk.gitvault.declareEpochSecretExposed(repoId);
    printJson(sdk, result);
    console.error(`declared epoch_secret_exposed for ${repoId} (epoch_secret_exposure_version now ${result.epoch_secret_exposure_version}).`);
    console.error("THIS DECLARATION DOES NOT ROTATE THE VAULT BY ITSELF — the next ordinary push now refuses EPOCH_ROTATION_REQUIRED until a rotate_epoch with reason:\"epoch_secret_exposed\" commits.");
    console.error("submit that rotation via r.gitvault.rotateEpoch({repo_id, reason: \"epoch_secret_exposed\", recipient_state_version, recipient_revocation_version}) once you have the two counter values (no CLI shortcut exists for this reason yet — see `run402 repos access repair --help`).");
    console.error("if a /confirm or /repin receipt is already pending for a directory principal, do NOT publish it separately (publishPinManifestUpdate is itself gated the same way) — pass it as rotateEpoch's pending_confirmations instead so it rides the SAME head as this rotation.");
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// gitvault-multi-writer (rev 47) task 6.4 — an on-demand tail on the
// existing `access` family: `r.gitvault.reconcile()` admits every eligible
// `pending_writers[]` candidate right now, rather than waiting for this
// machine's next push/deploy to do it as a side effect. Same shape as
// `accessRepin` above — one SDK call, echo the result, a next_action
// pointing at the normal follow-up.
async function accessSync(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, [...COMMON_VALUE_FLAGS, "--human", "-v", "--verbose", "--help", "-h"], COMMON_VALUE_FLAGS);
  requirePositionalCount(a, COMMON_VALUE_FLAGS, { min: 0, max: 0, command: "run402 repos access sync", missing: "" });
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const target = await vaultTarget(a);
  try {
    const result = await sdk.gitvault.reconcile(target);
    if (!human) console.log(JSON.stringify(result, null, 2));
    if (!result.eligible) {
      console.error("this machine's key is not an active writer on this vault — nothing to sync. Ask a current writer to admit you (org membership at role developer+ and a published signing key make you eligible).");
    } else if (result.admitted.length === 0) {
      console.error("no pending writer candidates — nothing to sync.");
    } else {
      for (const w of result.admitted) console.error(`admitted ${w.writer_key_id} (${w.principal_id}) at generation ${w.generation}.`);
    }
    if (result.skipped.length > 0) {
      for (const s of result.skipped) console.error(`skipped ${s.writer_key_id} (${s.principal_id}): ${s.reason}`);
    }
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

async function access(args) {
  const a = normalizeArgv(args);
  if (a[0] === "repair") return accessRepair(a.slice(1));
  if (a[0] === "revoke-key") return accessRevokeKey(a.slice(1));
  if (a[0] === "declare-exposure") return accessDeclareExposure(a.slice(1));
  if (a[0] === "repin") return accessRepin(a.slice(1));
  if (a[0] === "sync") return accessSync(a.slice(1));
  return accessRead(a);
}

// ─── recover ─────────────────────

/** `repos recover --human`: the same verdict the stderr lines already carry, condensed into one block. */
function formatRecoverHuman(result, outDir) {
  const lines = [
    `Repo: ${result.repo_id}`,
    `Recovered generation ${result.recovered_generation} into ${outDir}` +
      (result.chain_break ? ` (chain break at ${result.chain_break.generation} — fell back to the newest fully-verified generation)` : "") + ".",
  ];
  if (result.data_loss_detected) {
    lines.push(`DATA LOSS DETECTED: ${result.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences.`);
  }
  if (result.member_recovery) {
    lines.push(`Decrypted via member recovery bundle${result.member_recovery.bundle_key ? ` ${result.member_recovery.bundle_key}` : ""} + source recovery code (no keystore).`);
  }
  lines.push(`Layout: ${result.layout}` + (result.layout === "bare" ? " (no working files — not a failed recovery)" : ""));
  if (result.retained_refs?.warning) {
    lines.push(`refs/r402/retain: ${result.retained_refs.warning}`);
  } else if (result.retained_refs) {
    lines.push(`refs/r402/retain: ${result.retained_refs.retained_count} retained tip(s) referenced (+${result.retained_refs.written.length} -${result.retained_refs.deleted.length} this run).`);
  }
  return lines.join("\n");
}

/**
 * Read the source recovery code without echoing it (TTY) — a recovery code
 * is long-lived key material; it must never land in shell history (prefer
 * the prompt over `--code <value>`) and never echo into a scrollback.
 * Non-TTY stdin (piped) reads one line verbatim.
 */
async function promptSourceRecoveryCode() {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) {
      chunks.push(c);
      const s = Buffer.concat(chunks).toString("utf8");
      if (s.includes("\n")) return s.slice(0, s.indexOf("\n")).trim();
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const { createInterface } = await import("node:readline");
  stderr.write("Source recovery code (SRC1-…, input hidden): ");
  return await new Promise((resolve) => {
    const rl = createInterface({ input: stdin, terminal: true });
    // Mute the echo: readline in terminal mode writes through _writeToOutput.
    rl._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      stderr.write("\n");
      resolve(answer.trim());
    });
  });
}

async function recover(args) {
  const a = normalizeArgv(args);
  const valueFlags = ["--out", "--repo", "--profile", "--region", "--endpoint", "--bundle", "--code", "--receipt", "--rp-id"];
  assertKnownFlags(a, [...valueFlags, "--ambient", "--human", "-v", "--verbose", "--help", "-h"], valueFlags);
  const [source] = requirePositionalCount(a, valueFlags, {
    min: 1, max: 1, command: "run402 repos recover <source> --out <dir>",
    missing: "Missing <source>. Expected s3://<bucket>[/<prefix>] or a directory path.",
  });
  const outDir = flagValue(a, "--out");
  if (outDir == null) {
    fail({ code: "BAD_USAGE", message: "run402 repos recover needs --out <dir>.", hint: "Where to materialize the recovered repository, e.g. --out ./restored" });
  }
  const human = a.includes("--human");
  if (human && a.includes("--json")) {
    fail({ code: "BAD_USAGE", message: "--human cannot be combined with --json.", details: { flags: a.filter((arg) => arg === "--human" || arg === "--json") } });
  }
  const sdk = getSdk();
  const credential = resolveMirrorCredential(a);
  const repoId = flagValue(a, "--repo");
  const region = flagValue(a, "--region");
  const endpoint = flagValue(a, "--endpoint");
  // gitvault-recovery-custody — the human-member path: --bundle (the exported
  // r402s-member-recovery-bundle/v1; omit to use the mirror's own
  // member-recovery-bundles/ sidecar) + the source recovery code. --receipt
  // supplies the recovery-receipt pin when no keystore holds one (a member
  // has no keystore); --rp-id overrides the seal-time ceremony host.
  const bundlePath = flagValue(a, "--bundle");
  const receiptPath = flagValue(a, "--receipt");
  const rpId = flagValue(a, "--rp-id");
  let code = flagValue(a, "--code");
  const memberBundle = bundlePath != null ? readJsonFile("--bundle", bundlePath) : undefined;
  const recoveryReceipt = receiptPath != null ? readJsonFile("--receipt", receiptPath) : undefined;
  if (memberBundle !== undefined && code == null) code = await promptSourceRecoveryCode();
  try {
    const result = await sdk.gitvault.recover({
      source, out_dir: outDir,
      ...(repoId != null ? { repo_id: repoId } : {}),
      ...(credential ? { credential } : {}),
      ...(region != null ? { region } : {}),
      ...(endpoint != null ? { endpoint } : {}),
      ...(memberBundle !== undefined ? { member_bundle: memberBundle } : {}),
      ...(code != null ? { source_recovery_code: code } : {}),
      ...(recoveryReceipt !== undefined ? { recovery_receipt: recoveryReceipt } : {}),
      ...(rpId != null ? { rp_id: rpId } : {}),
    });
    if (human) {
      console.log(formatRecoverHuman(result, outDir));
      if (result.layout === "bare") for (const n of result.next_actions ?? []) console.error(`next: ${n.action} — ${n.command}`);
      printMirrorHonesty(result);
      printVerboseStats(a, sdk);
      return;
    }
    printJson(sdk, result);
    await spillIfLarge(result.repo_id, "recover", result);
    console.error(`recovered generation ${result.recovered_generation} for ${result.repo_id} into ${outDir}` + (result.chain_break ? ` (chain break at ${result.chain_break.generation} — fell back to the newest fully-verified generation)` : "") + ".");
    if (result.member_recovery) {
      console.error(`decrypted via member recovery bundle${result.member_recovery.bundle_key ? ` ${result.member_recovery.bundle_key}` : ""} (wrapper ${result.member_recovery.wrapper_id}, ${result.member_recovery.ek_fingerprint}) + source recovery code — no keystore involved.`);
    }
    if (result.data_loss_detected) {
      console.error(`DATA LOSS DETECTED: ${result.absences.filter((x) => x.adjudication === "unexplained_absence").length} object(s) are unexplained absences — see "absences" in the result above.`);
    }
    if (result.layout === "bare") {
      console.error(`layout: bare (no working files in ${outDir} — this is not a failed recovery)`);
      for (const n of result.next_actions ?? []) console.error(`next: ${n.action} — ${n.command}`);
    }
    // clone-installs-retained-refs D3: a bookkeeping failure degrades to
    // exactly one stderr note here — recovery's own result already landed
    // above.
    if (result.retained_refs?.warning) {
      console.error(`repos recover: ${result.retained_refs.warning}`);
    } else if (result.retained_refs) {
      console.error(`refs/r402/retain: +${result.retained_refs.written.length} -${result.retained_refs.deleted.length} (${result.retained_refs.retained_count} retained tip(s) total).`);
    }
    printMirrorHonesty(result);
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── recovery-bundle (gitvault-recovery-custody — the export half of `recover`) ─

/**
 * `run402 repos recovery-bundle` — export YOUR member recovery bundle
 * (`r402s-member-recovery-bundle/v1`): key identity + every ACTIVE wrapper
 * ciphertext. Together with the source recovery code — kept SEPARATELY —
 * it is what `repos recover --bundle` opens with no run402 server; a
 * server-side wrapper row alone is NOT offline backup, this export is.
 *
 * Principal-scoped, not repo-scoped (one bundle covers every vault you are
 * a recipient of) — which is why the auth is your control-plane (human)
 * session (`run402 operator login --loopback`), not the wallet. Without a
 * session the request falls back to the active WALLET's agent principal,
 * which normally holds no wrappers — truthful, with a stderr note saying so.
 * Enrollment/activation/revocation are browser ceremonies at
 * console.run402.com/account → Source access; this verb is read-only.
 */
function sourceAccessTokenOpts(commandLabel) {
  const cp = loadLiveControlPlaneSession();
  if (!cp) {
    console.error(
      `no control-plane (human) session — ${commandLabel} will answer for the active WALLET's agent principal, which normally holds no wrappers. Run 'run402 operator login --loopback' to act as yourself.`,
    );
    return {};
  }
  return { token: cp.control_plane_session_token };
}

async function recoveryBundle(args) {
  const a = normalizeArgv(args);
  assertKnownFlags(a, ["--out", "--json", "--help", "-h", "-v", "--verbose"], ["--out"]);
  requirePositionalCount(a, ["--out"], { min: 0, max: 0, command: "run402 repos recovery-bundle", missing: "" });
  const out = flagValue(a, "--out");
  const sdk = getSdk();
  try {
    const bundle = await sdk.operator.session.sourceAccessRecoveryBundle(sourceAccessTokenOpts("recovery-bundle"));
    // Full JSON to stdout regardless — the pipe contract is sacred; the file
    // is the keep-a-copy convenience (0600 — the bundle is ciphertext the
    // platform cannot open, but it is still half of a recovery credential).
    console.log(JSON.stringify({ ...bundle, stats: sdkStats(sdk) }, null, 2));
    if (out !== "-") {
      const path = out ?? `run402-source-recovery-bundle-${(bundle.ek_fingerprint || "key").slice(0, 11)}.json`;
      writeFileSync(path, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 });
      console.error(`bundle written to ${path} (0600).`);
    }
    console.error("keep this bundle SEPARATELY from your source recovery code — together they are equivalent to your member private key.");
    console.error("to make it travel with a vault mirror: copy it to member-recovery-bundles/<name>.json under the mirrored prefix; `run402 repos recover` finds it there.");
    printVerboseStats(a, sdk);
  } catch (err) {
    reportSdkError(err);
  }
}

// ─── dispatch ───────────────────────────────────────────────────────────────

/**
 * `run402 repos daemon <status|stop>` — the resident helper engine
 * (gitvault-persistent-helper D4). Purely local: a bounded socket probe,
 * never the network. `status` reports `{running:false}` when no daemon
 * answers (not an error — the daemon is an accelerator, never a
 * dependency); `stop` is idempotent the same way.
 */
async function daemonCmd(argv) {
  const args = normalizeArgv(argv);
  if (hasHelp(args)) {
    process.stdout.write("Usage: run402 repos daemon <status|stop>\n");
    return;
  }
  const sub = args[0];
  if (sub !== "status" && sub !== "stop") {
    fail({ code: "BAD_USAGE", message: "run402 repos daemon requires <status|stop>", hint: "Run `run402 repos daemon --help` for usage." });
  }
  // Lazy imports: this must stay reachable with zero heavy-graph cost, and
  // repos.mjs is already inside several config-mock test graphs.
  const { daemonSocketPath } = await import("./daemon-path.mjs");
  const { connect: netConnect } = await import("node:net");
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let socket;
    try {
      socket = netConnect(daemonSocketPath());
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      socket.destroy();
      done(null);
    }, 1000);
    let data = "";
    socket.on("data", (c) => {
      data += c.toString("utf8");
      const nl = data.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        try {
          done(JSON.parse(data.slice(0, nl)));
        } catch {
          done(null);
        }
        socket.end();
      }
    });
    socket.once("error", () => {
      clearTimeout(timer);
      done(null);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ t: sub === "stop" ? "stop" : "status" })}\n`));
  });
  if (sub === "status") {
    if (!result || result.t !== "status") {
      process.stdout.write(`${JSON.stringify({ running: false })}\n`);
    } else {
      const { t: _t, ...rest } = result;
      process.stdout.write(`${JSON.stringify({ running: true, ...rest })}\n`);
    }
  } else {
    process.stdout.write(`${JSON.stringify({ stopped: Boolean(result && result.t === "stopping") })}\n`);
  }
}

export async function run(sub, args) {
  const argv = Array.isArray(args) ? args : [];
  if (!sub || hasHelp([sub, ...argv])) {
    console.log(HELP);
    process.exit(0);
  }
  // gitvault-connection-amortization (bench P5): overlap the API dial with
  // the verb's local work — fire-and-forget, silent on every failure.
  void import("#sdk/node").then((m) => m.prewarmGitvaultConnection()).catch(() => {});
  switch (sub) {
    case "create": {
      await create(argv);
      break;
    }
    case "list": {
      await list(argv);
      break;
    }
    case "view": {
      await view(argv);
      break;
    }
    case "rename": {
      await rename(argv);
      break;
    }
    case "delete": {
      await del(argv);
      break;
    }
    case "snapshot": {
      await snapshot(argv);
      break;
    }
    case "handoff": {
      await handoff(argv);
      break;
    }
    case "resume": {
      await resume(argv);
      break;
    }
    case "invite": {
      await invite(argv);
      break;
    }
    case "join": {
      await joinInvite(argv);
      break;
    }
    case "policy": {
      await policy(argv);
      break;
    }
    case "mirror": {
      await mirror(argv);
      break;
    }
    case "fsck": {
      await fsck(argv);
      break;
    }
    case "gc": {
      await gc(argv);
      break;
    }
    case "daemon": {
      await daemonCmd(argv);
      break;
    }
    case "access": {
      await access(argv);
      break;
    }
    case "recover": {
      await recover(argv);
      break;
    }
    case "recovery-bundle": {
      await recoveryBundle(argv);
      break;
    }
    default:
      failUnknownSubcommand("repos", sub, {
        hint: "Run `run402 repos --help` for usage.",
      });
  }
}
