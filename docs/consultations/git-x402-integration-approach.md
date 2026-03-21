# Consultation Result

**Model**: gpt-5.4-pro
**Submitted**: 2026-03-07T10:04:26.298623
**Completed**: 2026-03-07T10:26:35.303645
**Status**: completed

---

Short answer: **yes, a custom remote helper is the right long-term write-path**, but I’d narrow it:

- **Use plain HTTPS for clone/fetch**
- **Use a custom `pushurl` for push only**
- **Do x402 + wallet auth in a preflight session API**
- **Then delegate to normal Git smart HTTP**

That gives you “`git push` creates/pays/deploys” without forcing Git itself to understand 402.

---

## My recommendation

### Primary architecture
Use this split:

```ini
[remote "run402"]
    url = https://git.run402.com/0xabc123/myapp.git
    pushurl = run402://myapp

[run402]
    tier = hobby
    visibility = public
    autoPayMax = 5.00
```

Then the flow is:

```text
git push run402 main
  -> Git uses pushurl, invokes git-remote-run402
  -> helper calls POST /v1/git/push-session
       - if repo missing: x402 create
       - if expired: x402 renew
       - if active: wallet-auth only
  -> API returns short-lived Git session credential
  -> helper delegates to standard smart HTTP push
       https://git.run402.com/0xabc123/myapp.git
  -> post-receive hook deploys and streams output
```

### Why this is better than “helper everywhere”
Because **public reads should be zero-install**.

If you make clone/fetch require a helper too, you lose a lot of the “GitHub without the Hub” feel. Public repos should ideally be:

```bash
git clone https://git.run402.com/0xabc123/myapp.git
```

No helper, no wallet, no MCP, no install.

The helper should mainly exist for the write path, because that’s where payment + ownership matter.

---

# Answers to your 6 questions

## 1. Is a custom git remote helper the right technical choice?

### Yes — but implement it as a **thin preflight wrapper**, not a full Git transport.

The helper should **not** implement packfile transport itself. It should:

1. Parse the Run402 remote
2. Load signer
3. Call your API for a push session
4. Handle x402 there
5. Get back a short-lived Git auth token
6. **Exec/delegate to `git-remote-http`** (or equivalent stock helper)

That is the key design choice.

### Best pattern: use `pushurl`
This is the biggest refinement I’d suggest.

Instead of:

```bash
git remote add run402 run402://hobby/myapp
```

prefer:

```bash
git remote add run402 https://git.run402.com/0xabc123/myapp.git
git remote set-url --push run402 run402://myapp
git config run402.tier hobby
```

Why:

- fetch/clone stay standard
- only push needs special logic
- auto-renew on write is easy
- you avoid weird semantics for reads
- agents can still clone public repos with zero install

### Gotchas
The real gotchas are not x402; they’re Git ergonomics:

#### a) Don’t put tier in the URL
`run402://hobby/myapp` looks nice but ages badly.

If the repo upgrades from hobby → team, does the remote URL change? That’s awkward.

Better:
- remote URL identifies repo
- tier lives in `.git/config`, `run402.yaml`, or server state

#### b) Don’t expose tokens in the remote URL if you can avoid it
This is tempting:

```bash
https://<token>@git.run402.com/myapp.git
```

But tokens leak into:
- `.git/config`
- `git remote -v`
- process lists
- logs
- shell history

Use that only as a fallback path.

#### c) Make the session API **single-shot**
Don’t do:

- GET exists
- POST create
- POST renew
- POST session

Do:

```http
POST /v1/git/push-session
```

with semantics like:

- create if missing
- renew if needed
- no-op if active

That avoids races and simplifies helper code.

#### d) Make it idempotent
Git retries. Helpers retry. Networks fail.

Your session/create endpoint should support idempotency keys so you don’t double-charge or double-provision.

#### e) Never return HTTP 402 from the Git transport endpoint
Only return 402 from your **session/payment API**.

The actual Git smart HTTP endpoint should see only:
- valid auth → proceed
- missing/expired auth → 401/403

Git should never be asked to reason about payment.

### How agents install/configure it
I would ship **one `run402` binary/package** that exposes:

- `run402`
- `git-remote-run402`
- optionally `git-credential-run402`

And then provide:

```bash
run402 init myapp --tier hobby
```

which:

- detects wallet
- installs/validates helper
- adds remote
- sets pushurl
- stores config

### Does `npx` work reliably?
**As bootstrap: yes-ish. As runtime dependency: no.**

#### Good use of `npx`
```bash
npx -y @run402/cli install
```

#### Bad use of `npx`
Having Git effectively do `npx ...` on every push.

Problems:
- requires Node/npm in environment
- can hit network on push
- PATH/global install may not persist
- some agent environments disallow global writes
- interactive npm prompts can hang agents unless you force `-y`

### My advice on packaging
- **v1:** npm package is fine if your target agents already have Node
- **but** make `npx` only a bootstrap/install step
- **v2:** likely ship standalone binaries too

For Claude Code / Cursor / Cline style local-terminal agents, a persistent helper is usually fine **if installed once**. I would not rely on ephemeral `npx` execution during a Git operation.

---

## 2. Is there room for a git credential helper instead?

### Yes, but as a **secondary tool**, not the main mechanism.

A credential helper is good for:
- issuing short-lived auth tokens for **existing** repos
- private fetch/clone later
- plain HTTPS remotes
- caching repo-scoped tokens for a few minutes

A credential helper is **bad** for:
- create-on-first-push
- renew-on-write
- payment side effects
- deploy output UX

### Why it’s the wrong primary abstraction
Git’s credential machinery is fundamentally “give me credentials for this URL.”

It does **not** naturally tell you:
- whether this is push vs fetch
- whether repo creation is intended
- whether billing side effects are acceptable

So if you make `credential fill/get` auto-create a missing repo, then:
- `git ls-remote`
- `git fetch`
- `git clone` of a missing URL

could accidentally trigger a paid create. That’s not good.

### Important protocol nuance
You mentioned:

- `git credential fill/approve/reject`

That’s the **plumbing interface**. External credential helpers are typically invoked with:

- `get`
- `store`
- `erase`

Either way, the limitation is the same: **the helper gets host/path credentials context, not clean write-intent semantics**.

### Best use of a credential helper here
Later, add:

```bash
git config --global credential.https://git.run402.com.helper run402
git config --global credential.https://git.run402.com.useHttpPath true
```

Then `git-credential-run402` can:
- mint short-lived read/write tokens for existing repos
- cache them briefly
- never create/renew/pay

That’s useful. Just don’t make it the first-push path.

---

## 3. Should you skip git entirely and build a git-like CLI?

### Long-term: **no**
If the product vision is wallet-owned repos, public forks, and “GitHub without the Hub,” then **real Git compatibility matters**.

A fake Git-like deploy command is fine for deployment, but it’s not enough for:
- clone
- fork
- branches
- existing tooling
- public network effects

### Short-term: **yes, ship a wrapper CLI too**
I would absolutely ship:

```bash
run402 push
```

as a fallback / bootstrap path.

Not because Git should be replaced — but because:
- some agents won’t have the helper installed
- some environments won’t persist installs
- you already have an API deploy flow today

So the practical answer is:

- **Primary product UX:** `git push`
- **Fallback UX:** `run402 push`
- **Control plane:** API/MCP

### Important distinction
A wrapper CLI is much better than inventing a new wire protocol.

`run402 push` can still:
- inspect local Git state
- call the same session API
- use the same short-lived token
- invoke `git push` underneath

So this doesn’t fragment your architecture much.

---

## 4. What would OpenClaw / terminal agents actually prefer?

### They prefer the path with the fewest surprises:
1. one-time setup
2. normal Git verbs
3. no browser auth
4. no hidden prompts
5. machine-readable failures

So I think the best path is:

```bash
run402 init myapp --tier hobby
git push run402 main
```

That’s better than asking them to remember:
- token URLs
- manual remote surgery
- multi-step auth dances

### What they probably won’t love
- browser/device OAuth
- dashboard setup
- “copy this token into your remote URL”
- helper install that silently modifies shell config and requires restart
- interactive payment prompts during `git push`

### MCP role
MCP is great for:
- create/list/fork/renew
- setting secrets
- reading deploy status
- managing projects

MCP is **not** the right place to move packfile transport. Git already solves that.

So: **MCP as control plane, Git as data plane**.

---

## 5. How should wallet signing work in the helper?

### Short answer
Use a signer abstraction with multiple backends.

### Recommended signer backends

#### Default for agents: env var
```bash
export RUN402_PRIVATE_KEY=0x...
```

Pros:
- easiest in headless automation
- already matches how many agent environments inject secrets
- works with `@x402/fetch` and viem immediately

Cons:
- broad trust boundary
- env vars can leak to child processes if you’re careless

#### Better for humans: encrypted local keystore
Something like:

```text
~/.config/run402/wallet.json
```

protected with passphrase / OS keychain.

#### Better long-term: external signer daemon
`ssh-agent` style model:

- helper talks to local `run402-walletd` over socket
- daemon holds key
- helper requests `signTypedData` / `signMessage`
- raw private key never lives in the Git helper process

This is probably overkill for v1 but a very good long-term shape.

### Critical security rule
**Do not let the private key flow into the Git child process.**

The helper should:
- load the signer
- do x402/session signing
- get back a short-lived Git token
- then **scrub key env vars** before delegating to Git transport

Pass only the temporary Git session credential downstream.

### Session token design
Make Git session tokens:

- repo-scoped
- op-scoped if possible (`receive-pack` vs `upload-pack`)
- short TTL (5–10 min)
- single-purpose
- issued by your API, not stored in repo config

### Practical v1 recommendation
For agent environments, I’d start with:

- `RUN402_PRIVATE_KEY`
- `RUN402_AUTO_PAY_MAX`
- dedicated low-balance wallet

Then later add:
- keystore
- signer daemon
- delegated agent keys

### One more strong suggestion
Design for **delegated agent wallets** eventually.

Meaning:
- durable owner wallet owns namespace
- low-value agent wallet is authorized to push/pay within caps

That’s a much safer long-term model than giving agents the “real” owner key.

---

## 6. Could the git credential helper protocol help?

### Yes, but only for auth/session minting
If you implement `git-credential-run402`, use it for:

- existing repo auth
- private read access
- maybe existing repo push auth

Not for:
- create-if-missing
- renew-with-payment
- lease policy

### If you do implement it, require `useHttpPath`
Very important:

```bash
git config --global credential.https://git.run402.com.useHttpPath true
```

Without that, Git may reuse one credential across all repos on `git.run402.com`, which is the opposite of what you want for repo-scoped session tokens.

### Good division of labor
- **Remote helper (`pushurl`)**: create / renew / pay / push
- **Credential helper**: existing repo HTTPS auth, especially private fetch

That division is clean.

---

# What I would build, concretely

## 1. A single API endpoint [FUTURE]
```http
POST /v1/git/push-session
```

Request:
```json
{
  "repo": "myapp",
  "tier_hint": "hobby",
  "visibility": "public",
  "create_if_missing": true
}
```

Behavior:
- verify wallet proof
- if missing: return 402 quote, then create on paid retry
- if expired: return 402 quote, then renew on paid retry
- if active: mint session directly

Response:
```json
{
  "git_url": "https://git.run402.com/0xabc123/myapp.git",
  "auth": {
    "scheme": "basic",
    "username": "x-access-token",
    "password": "sess_..."
  },
  "created": true,
  "lease_expires_at": "2026-04-07T00:00:00Z"
}
```

I’d accept both:
- Basic auth (`x-access-token:sess_...`)
- optionally Bearer

Basic is nice because it also works with credential helpers.

## 2. A `run402 init` command [FUTURE]
```bash
run402 init myapp --tier hobby --visibility public
```

This should:
- install/verify helper
- detect wallet address
- add remote
- set pushurl
- store local billing hint / caps

## 3. `git-remote-run402` [FUTURE] - Partially exists but session API not complete
It should:
- call `/v1/git/push-session`
- use `@x402/fetch`
- mint short-lived token
- delegate to `git-remote-http`

## 4. `run402 push` fallback [FUTURE]
For no-install environments:

```bash
npx -y @run402/cli push
```

Internally it can do the same preflight + delegated Git push.

This is the “agents can still succeed even if helper install is awkward” escape hatch.

## 5. Optional later: `git-credential-run402` [FUTURE]
For private HTTPS fetch/clone of existing repos.

---

# My actual recommendation by approach

## Approach A: custom remote helper
**Yes, with one tweak: use it as the push path, via `pushurl`.**
This is your best long-term design.

## Approach B: payment outside Git entirely
**Keep this as fallback / bootstrap.**
It is simpler, reliable, and useful in MCP-heavy or no-install environments.

## Approach C: something else entirely
The best “something else” is **not** a fake Git protocol.
It’s:
- a normal CLI (`run402`)
- with a remote helper as an implementation detail
- plus `run402 push` fallback
- plus optional credential helper later

---

# If I were prioritizing

### Phase 0 [FUTURE]
Ship:
- `run402 init`
- `run402 push`
- existing API backend underneath

Validate agent DX.

### Phase 1 [FUTURE]
Add:
- hosted Git smart HTTP
- `POST /v1/git/push-session`
- `git-remote-run402`
- post-receive deploy hooks

### Phase 2 [FUTURE]
Add:
- public clone over HTTPS
- private clone via credential helper
- forks
- delegated agent wallets

---

# Final bottom line

**Use a custom remote helper, but only for push.**  
Specifically:

- **HTTPS URL for reads**
- **`run402://...` pushurl for writes**
- **single `/v1/git/push-session` API that handles create/renew/x402**
- **short-lived Git session token**
- **delegate to stock smart HTTP**
- **ship `run402 push` as fallback**
- **use credential helper only later, for existing repo auth**

That gives you the cleanest split between Git and x402:
**payment is a session-broker concern, not a Git transport concern.**

If you want, I can sketch the exact helper implementation pattern next — including how `git-remote-run402` can exec `git-remote-http` with temporary auth and how to structure the `push-session` API for idempotency.

---
**Tokens**: 2,060 input, 34,653 output, 36,713 total
