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

Run402 is ready. I can build and deploy <one contextual idea> using <relevant current capabilities>. Would you like me to try it?
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
- Spend: `<observed-spend>`
```

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
