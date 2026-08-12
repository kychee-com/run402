# Buzz receipts

Report public identifiers and observed state only. Never include private keys, mnemonics, seeds, cookies, bearer credentials, service keys, SIWX payloads, payment proofs, secret values, or secret-bearing headers.

## Ready

```markdown
### Run402 is ready
- Buzz agent: `npub1…`
- Profile label: `buzz-fizz`
- Profile selection: `explicit_argument`
- Run402 wallet: `0x…`
- Principal: `prin_…` (`agent`)
- CLI: `<version>` (`reused|installed_or_updated`, user-global npm)
- Profile state: `reused|initialized`
- Identity link: `idlnk_…` (`active`, `reused|created`)
- Deployment: `none`
- Community connection: `available|relay_unavailable|not_selected` (preserve the exact relay repair when unavailable)
- Notification routing: `none|<buzzper_… status/health>` (optional delivery state beneath the community connection — never identity or authority; omit-or-`none` is the normal fresh-setup value)

Done—Run402 is connected to my Buzz identity. Would you like me to build and deploy <one contextual idea> as a quick demo?
```

Do not claim an active tier, project, allowance balance, or deployed application unless separately observed after the user approves that work.

## Deployment complete

```markdown
### Deployment complete
- Buzz agent: `npub1…`
- Profile label: `buzz-fizz` (`explicit_argument`)
- Run402 wallet: `0x…`
- Principal: `prin_…`
- Identity link: `idlnk_…` (public dual proof; separate keys)
- Project: `prj_…`
- Owning organization: `org_…`
- Release: `rel_…`
- Source: `<commit-or-equivalent>`
- URL: `https://…`
- Tier: `<observed-tier>`
- Lease expires: `<ISO-8601-or-none>`
- Verification: `<exact HTTP and critical-flow checks>`
- Network: `base_sepolia|<observed-network>`
- Funding source: `faucet|<observed-real-value-rail>`
```

For Base Sepolia faucet-backed demos, keep network/faucet provenance in the expanded receipt but omit price, cost, purchase, and spend language from ordinary Buzz conversation. Real-value rails retain the normal spend disclosure.

## Adoption offer

```markdown
Done—I built it, deployed it, and verified it at <verified URL>.
Would you also like to become a co-owner of the Run402 organization that owns this deployment?
[Become an owner](https://console.run402.com/buzz/adoptions/buzzhao_…)
```

Expanded non-secret state may include the offer id, organization, identity link, safe deployment context, status, and one `next_action`. Never include a session, credential, raw callback event, or short-lived `buzz://` challenge in chat.

## Adoption complete

```markdown
### Ownership handoff complete
- Consent receipt: `buzzha_…` (`completed`)
- Public Buzz identity link: `idlnk_…` (`active`; attribution only)
- Organization membership: `<membership-id>` (`owner`; grants organization authority)
- Founder agent: remains an owner

The identity link and organization membership are independently revocable; neither action rewrites the completed consent receipt.
```

Report success only from the authoritative completed offer/adoption response.
Opening the handoff link, returning a callback, or observing a Buzz signature is
not completion. Never describe the public identity link as authentication or
organization authority.

## Blocked

```markdown
### Run402 blocked
- Stage: `<exact-stage>`
- Error code: `<stable-code-or-local-fallback>`
- Mutation state: `none|not_started|committed|rolled_back|partial|unknown`
- Ownership effect: `none|<observed-effect>`
- Next action: `<one bounded action>`
```

If a deploy created a release but verification failed, include the release id and observed failure while reporting `Deployment verification failed`, never `Deployment complete`.
