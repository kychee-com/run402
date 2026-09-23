---
title: "Local state: wallets, organizations, doctor, init, status"
description: "Native SDK reference — the machine's own state, owned by @run402/sdk/node."
order: 35
---

## Local state (`@run402/sdk/node`)

The Node entry owns everything about the machine it runs on: which wallet is active and how it was chosen, which organization a call addresses, the health report, first-run setup, and the local status view. The CLI verbs (`run402 wallets …`, `run402 orgs use|current|clear|bind|unbind`, `run402 doctor`, `run402 init`, `run402 status`) are shims over these methods and print exactly what they return, so a program on the SDK sees the same answer the CLI prints in the same directory.

### Wallets and wallet selection

A **wallet** is a named local profile: its own key, project-key cache, and non-secret `meta.json`. The reserved `default` wallet lives at the config-dir root. The active wallet is chosen by one precedence chain, highest first:

1. an explicit flag value (`--wallet <name>`)
2. `RUN402_WALLET` (or `RUN402_PROFILE`)
3. the nearest `.run402.local.json` / `.run402.json` binding, walking up from the working directory
4. the global default recorded by `wallets use`
5. `default`

An env value that disagrees with a directory binding is `WALLET_SELECTION_CONFLICT`, never a silent pick.

```ts
const current = await r.wallets.current();
// { local_label: "client-a", source: "binding", source_detail: "/work/.run402.json",
//   address, server_label, configured, created, rail, faucet_used, path, warnings }

const all = await r.wallets.list();           // [{ local_label, server_label, address, address_short, rail, active }]
await r.wallets.create("ci", { rail: "x402" }); // a new named wallet; its key stays local
await r.wallets.use("ci");                      // the global default
await r.wallets.rename("ci", "ci-deploy");
await r.wallets.bind("ci-deploy");              // writes ./.run402.json (a name, never a key)
await r.wallets.unbind();
await r.wallets.remove("ci-deploy", { confirm: true });
```

`r.wallets.import(name, privateKey)` adopts an existing key; `privateKey` may be a function, called only after the name checks pass. `resolveWalletSelection()`, `assertWalletExists()`, and `selectWallet()` (which also publishes the selection to the environment for the rest of the process) are exported for programs that choose a wallet before building a client.

### Organization context

`r.orgs.resolve()` is the one resolver every org-scoped call uses. Four intent classes, highest first, a named organization outranking a named project's organization inside each: the flag (`org`, then `project`), the environment (`RUN402_ORG`, the org half of `RUN402_ROOM`, then `RUN402_PROJECT_ID`), the directory binding's `org` key (then this checkout's vault pin), and the profile state (`orgs use`, then the active project). It never infers an organization from memberships. It throws `BAD_ORG_ID`, `AMBIGUOUS_ORG` (env and binding disagree), or `ORG_REQUIRED`, each with `next_actions` naming every way to supply one.

```ts
const resolved = await r.orgs.resolve({ project: projectId });
// { orgId, source: "flag", sourceDetail: "--project" }

await r.orgs.use("11111111-2222-4333-8444-555555555555");
const current = await r.orgs.current();       // { org_id, org_source, org_source_detail, selected_org_id } — null when nothing is selected
await r.orgs.bind(null, { room: "dev" });       // writes org (your sole membership when unnamed) and room into ./.run402.json
await r.orgs.unbind();
await r.orgs.clear();
```

### Doctor

`r.doctor()` returns `{ ok, blocking[], warnings[], checks[] }`. `ok` is true exactly when nothing blocks a deploy; every check carries `severity` `blocking | advisory | info`, advisory gaps ride in `warnings[]`, and an unknown status fails closed as blocking. The tier check's `status` is a fixed vocabulary (`ok | inactive | frozen | past_due | dormant | purged | missing | unknown | error`), never a tier name.

```ts
const report = await r.doctor({ only: ["tier", "vault"], project: projectId });
if (!report.ok) console.error(report.blocking);
```

`only` runs just the named checks and skips the others' work; `DOCTOR_CHECK_NAMES` lists them. The update check for the calling program and its resident helper are hooks (`cliUpdate`, `daemonStatus`); without them `cli_update` reports `skipped`.

### Init

`r.init()` sets up the active profile: the wallet on its payment rail (`x402` by default, `mpp`, or `lightning`), testnet funding, an optional `voucher`, the Lightning wallet, the tier read, the local project count, the vault git remote, the organization, and one next action. Progress lines go to `onLine`; the result is the summary `run402 init` prints. Re-running on the same rail is idempotent; another rail needs `switchRail: true`. `r.init({ apiBase })` configures a Run402 Core target instead and touches no wallet.

```ts
const summary = await r.init({ onLine: (line) => console.error(line) });
console.log(summary.next_step);   // "run402 up -y" until the account holds a tier
```

### Status

`r.status()` is the local view: the active wallet (`local_label`, `server_label`, address), its rail, grouped `balances` (on-chain and allowance), the tier and lease, the projects (server-side, else the local key cache), the active project, and the API target. With no local wallet it returns `wallet: null`, the locally known projects, and the next command. It never returns key material. A wallet file that exists but cannot be read makes `r.status()`, `r.init()`, and `r.doctor()` throw `BAD_WALLET_FILE`, naming the file and `run402 init`.

### Origin probe

`r.diagnostics.probeOrigin(url)` makes one bounded, anonymous `GET` that never follows a redirect and classifies the outcome instead of throwing: `ok`, `dns`, `tls`, `redirect` (with `redirect_to`), `http`, `timeout`, or `network`. `r.buzz.doctor()` measures the Run402 API and console with it.

```ts
const probe = await r.diagnostics.probeOrigin("https://api.run402.com/status");
if (!probe.reachable) console.error(probe.classification, probe.error);
```

### One-time secrets and the sandbox surface

Every client carries `capabilities.returnSecrets`. It is `true` for the `cli`, `sdk`, and `mcp` surfaces and `false` for `sandbox`, the surface an MCP `run` snippet executes on. A method whose result carries a one-time secret the caller would receive — a grant key, a Handoff or Invite Key, a Room Invite Key, project credentials, a private key, a Lightning pairing, a sign-in session or write-approval token — or whose input is such a bearer secret, refuses on a `sandbox` client before any request with `SECRET_REQUIRES_CLI` and exactly one `next_actions` entry of type `run_cli_command` naming the CLI command for the same operation. On every other surface it runs as documented.

```ts
try {
  await r.project(projectId).grants.create({ wallet: wallet.address, capability: "deploy", key: {} });
} catch (err) {
  if (err instanceof LocalError && err.code === "SECRET_REQUIRES_CLI") {
    console.error(err.nextActions?.[0]?.command); // run402 grants create 0x… --capability deploy --key --project prj_…
  }
}
```

`SECRET_RETURNING_METHODS` (exported from `@run402/sdk`) lists every gated method and its command.
