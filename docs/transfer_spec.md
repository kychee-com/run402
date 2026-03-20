# Transfer Spec: Multi-Wallet Ownership & Project Handoff

## Motivation

A contractor agent builds a project on Run402, then sells/transfers it to a company agent. Today there's no way to do this — a project is bound to the wallet that provisioned it. We need a mechanism for adding and removing wallet-level access so ownership can change hands gracefully.

## End-to-End Story

### Contractor: Building the thing

```bash
mkdir new-app && cd new-app
git init
npm init -y
# ... builds the app ...

# First deploy to Run402
run402 init
# → Authenticates with contractor's wallet
# → Creates a new project on Run402
# → Writes run402.json: { "project": "proj_a1b2c3" }
# → Maybe also claims new-app.run402.com

run402 deploy
# → Deploys the site to new-app.run402.com

git add . && git commit -m "Initial version"
gh repo create contractor/new-app --push
```

### Contractor: Showing it to the client

"Hey, check out new-app.run402.com"

Client looks at the deployed site. They like it. Deal is made.

### Contractor: Initiating the handoff

```bash
# Add client as GitHub collaborator
gh repo add-collaborator contractor/new-app client-org

# Invite client's wallet to co-own the Run402 account
run402 wallet invite acme-corp.eth
# → Creates a pending invite on Run402
# → "Invite sent to acme-corp.eth. They'll need to run 'run402 init' in the repo."
```

### Client: Taking ownership

```bash
git clone github.com/contractor/new-app
cd new-app

# run402.json is already there: { "project": "proj_a1b2c3" }

run402 init
# → Reads run402.json, sees proj_a1b2c3
# → "This repo is linked to project proj_a1b2c3 (new-app.run402.com)"
# → "You have a pending invite from contractor.eth. Accept? [y/n]"
# → Client's wallet signs a challenge to prove key ownership
# → "You're now a co-owner. Run 'run402 status' to see your project."
```

`run402 init` is the one command the client needs to know. It's context-aware:
- **No run402.json?** → Creates a new project (fresh start)
- **run402.json exists + pending invite?** → Accepts the invite, connects you
- **run402.json exists + already an owner?** → "You're already set up"

### Overlap period

Both wallets now have full, equal control. The client can deploy, run SQL, manage the database — verify everything works.

### Client: Completing the transfer

```bash
# When satisfied, remove the contractor
run402 wallet remove contractor.eth
# → Contractor loses access immediately
# → Client is now the sole owner

# Transfer complete.
```

## Core Concept: Two-Step Transfer

Transfer is not atomic. It happens in two steps with an intentional overlap period where both wallets have full control:

```
# Step 1: Contractor invites the company's wallet
run402 wallet invite acme-corp.eth

# (client accepts via run402 init)
# (overlap period — both wallets can see and control everything)

# Step 2: Company removes the contractor's wallet
run402 wallet remove contractor.eth
```

This mirrors how real-world handoffs work: you give someone the keys, they verify everything works, then you hand over sole ownership. The overlap is a feature, not a bug.

## CLI Commands

```
run402 init                              # Smart setup: creates project OR accepts invite
run402 wallet invite <address-or-ens>    # Invite a wallet to co-own your account
run402 wallet remove <address-or-ens>    # Remove a wallet from the account
run402 wallet list                       # Show all wallets on your account
run402 wallet invites                    # Show pending invites (sent and received)
run402 status                            # Show project health, owners, etc.
```

Note: there is no explicit `wallet accept` command. Accepting happens through `run402 init` when run in a repo with an existing `run402.json` and a pending invite. This keeps the client's experience simple — one command.

### Address Formats

Both raw addresses and ENS-style names should work:

```
run402 wallet invite 0x1234abcd...
run402 wallet invite acme-corp.eth
run402 wallet invite contractor.run402.eth   # Run402-native names?
```

## run402.json

Checked into the repo. Links a repo to a Run402 project:

```json
{
  "project": "proj_a1b2c3"
}
```

This is how the client knows which project they're connecting to when they clone and run `run402 init`. The link travels with the code.

Open questions:
- What else goes in here? Region? Subdomain? Deploy config?
- Should it be `.run402.json` (hidden) or `run402.json` (visible)?
- Is there also a local config (gitignored) for wallet-specific stuff?

## Visibility Model

The relationship is **asymmetric**:

- If wallet A invites wallet B → B can see and control everything A has
- A does NOT get access to B's stuff
- It's a one-way grant, not a mutual merge

Think of it like: A is saying "B is also me" for the purposes of my projects. Not "A and B are the same entity."

### What "see everything A has" means

When B is added to A's account, B gets:

- Full access to all of A's projects (databases, files, deployed sites)
- Ability to run SQL, call REST endpoints, deploy
- Ability to invite/remove other wallets
- Ability to provision new projects under A's account

All wallets on an account are equal owners. No hierarchy, no roles, no permissions matrix.

## Scope: Account-Level First

**V1: Account-level only.** `wallet invite` grants access to ALL projects owned by the granting wallet's account. This covers the primary use case: contractor sells everything they built.

**Future (V2):** Add `--project` scoping for partial transfers. Not in scope for now.

## The Overlap Period

During the overlap, both wallets have equal power.

### Who pays?

Since x402 charges the wallet that makes the API call directly, this probably just works — the wallet that calls the API pays. No special billing logic needed.

### Who can add/remove?

All wallets on an account are equal owners. Any owner can:
- Invite a new wallet
- Remove any wallet (including themselves)
- Do anything with any project on the account

### Duration

Indefinite until explicitly resolved. No TTL on the overlap.

## Trust & Security

### The invite is a two-sided handshake

1. A initiates: `run402 wallet invite 0xB` → creates a pending invite
2. B accepts via `run402 init` → B must sign a challenge to prove they control the key
3. Grant becomes active only after B accepts and proves ownership

### The "remove" is destructive

`wallet remove` immediately revokes access. Questions:

- Is it instant or is there a grace period?
- Can a removed wallet's active sessions keep working or are they killed immediately?
- Should there be an undo window?

### Minimum owner count

Must enforce at least 1 wallet on every account. The last wallet cannot remove itself — prevents orphaned projects.

## ENS / Naming

Raw addresses are hard to work with. ENS-style names make this more usable:

```
run402 wallet invite acme-corp.eth
```

### Open Questions

- Do we resolve ENS names on-chain at invite time and store the resolved address?
- What if the ENS name changes hands later — does the invite/grant follow the name or the address?
- Should Run402 have its own namespace? (`acme.run402.eth` or `acme.r402`)
- How does this interact with `claim_subdomain`? Is `acme.run402.com` related to `acme.run402.eth`?

## Data Model (Sketch)

Today a project is owned by a single wallet. We introduce an **account** as a bag of wallets:

```sql
-- An account is a group of wallets that share ownership
CREATE TABLE internal.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallets belonging to an account
CREATE TABLE internal.account_wallets (
  account_id UUID NOT NULL REFERENCES internal.accounts(id),
  wallet_address TEXT NOT NULL,
  added_by TEXT,                     -- which wallet invited this one
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, wallet_address)
);

-- Pending invites (not yet accepted)
CREATE TABLE internal.wallet_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES internal.accounts(id),
  inviter_wallet TEXT NOT NULL,
  invitee_wallet TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  UNIQUE(account_id, invitee_wallet)
);
```

Projects get an `account_id` FK instead of (or in addition to) their current wallet-level ownership. Auth goes from "which wallet paid → find its projects" to "which wallet paid → find its account(s) → find all projects on those accounts."

### Migration

Every existing wallet gets an implicit single-wallet account. No user-facing change until they use `wallet invite`.

## API Layer

```
POST   /v1/wallet/invite    { "invitee": "0x..." }                     -- create invite
POST   /v1/wallet/accept    { "account_id": "...", "sig": "0x..." }    -- accept + prove key
DELETE /v1/wallet/members    { "wallet": "0x..." }                      -- remove a wallet
GET    /v1/wallet/members    → list all wallets on your account
GET    /v1/wallet/invites    → list pending invites (sent and received)
```

All endpoints authenticated by the caller's wallet via x402 payment.

### Auth Change

Today: wallet → projects (1:1 lookup).
After: wallet → account(s) → projects. The x402 payment identifies the wallet, we look up which account(s) it belongs to, and that gives us the project set. Simple fan-out, no new auth mechanism needed.

## CLI Authentication

Open question: how does the CLI know which wallet it's acting as?

Options:
- **Env var**: CLI reads a private key from `PRIVATE_KEY` env var or `.env` file. Simple, works for agents.
- **`run402 login`**: A setup command that stores wallet credentials in `~/.config/run402`. More ceremony but keeps keys out of the repo.
- **Both**: Check env var first (for agents/CI), fall back to `~/.config/run402` (for humans). Flexible.

The key is needed to sign x402 payments and the accept challenge during `run402 init`.

## MCP Server Impact

The MCP tools (`run_sql`, `rest_query`, `deploy_site`, etc.) authenticate via API key tied to a wallet. With multi-wallet accounts:

- Each wallet keeps its own API key / x402 auth — no sharing of keys
- The gateway resolves wallet → account(s) → projects on every request
- New MCP tools needed: `wallet_invite`, `wallet_remove`, `wallet_list`?

## Edge Cases & Open Questions

1. **Multiple accounts**: Wallet B could be on its own account AND get invited to A's account. Now B belongs to 2 accounts. When B provisions a new project, which account does it go under? Do we require a `--account` flag? Use the one from `run402.json`?

2. **Last wallet standing**: The last wallet on an account cannot remove itself. Must be enforced server-side.

3. **Concurrent removes**: A and B both try to remove each other simultaneously. Last-write-wins? Or block mutual removal?

4. **Audit trail**: Should there be a log of who did what during the overlap period? Important for the "contractor did something sketchy before being removed" case.

5. **Invite spam**: Can anyone invite any wallet? Rate limit invites? Probably fine for V1.

6. **`run402 init` with no invite**: Client clones repo, runs `run402 init`, but there's no pending invite. What happens? "You don't have access to this project. Ask the owner to run 'run402 wallet invite <your-address>'"?

7. **Git and Run402 are independent**: Run402 ownership and GitHub access are completely separate concerns. You can be on the Run402 account without being a GitHub collaborator and vice versa. The CLI could warn if they're out of sync, but doesn't enforce.

8. **What if the contractor deletes the GitHub repo?**: Client still has Run402 access (and their local clone). The run402.json link still works. Run402 doesn't depend on GitHub.

## Non-Goals (For Now)

- Read-only access (viewer role) — all owners are equal for now
- Permission levels (admin vs editor vs viewer)
- Project-level scoping (`--project`) — V2
- Team/org abstractions — this is wallet-to-wallet only
- On-chain ownership NFTs — grants are stored in Run402's DB, not on-chain
- Multi-sig requirements for sensitive operations

## Next Steps

- [x] Decide: account-level first or project-level from day one? → **Account-level first**
- [x] Decide: one-sided push or two-sided handshake? → **Two-sided, B must accept and prove key**
- [x] Decide: all owners equal? → **Yes, no hierarchy**
- [ ] Decide: CLI auth mechanism (env var, login command, or both?)
- [ ] Decide: ENS resolution strategy
- [ ] Decide: run402.json format and what goes in it
- [ ] Design the `run402 init` state machine (new project vs accept invite vs already connected)
- [ ] Prototype the CLI commands against a local gateway
