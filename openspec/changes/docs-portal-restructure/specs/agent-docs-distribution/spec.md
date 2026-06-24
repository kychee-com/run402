## ADDED Requirements

### Requirement: Task-specific agent docs let an agent load only what a task needs

In addition to the comprehensive `llms-*.txt`, the docs surface SHALL provide smaller task-scoped machine documents (`/agent/{start,astro,deploy,auth,database,storage,errors,allowances}.txt`), generated from the same single source (not hand-authored). The apex `llms.txt` wayfinder SHALL route agents by task first and interface second, so an agent building an authenticated Astro app need not load every email/contract/admin/org reference.

#### Scenario: An agent loads a task slice, not the whole reference

- **WHEN** an agent needs to deploy and fetches `https://docs.run402.com/agent/deploy.txt`
- **THEN** it SHALL receive the deploy-scoped reference
- **AND** that file SHALL be generated from the same canonical content as the comprehensive references (no drift)

#### Scenario: Wayfinder routes by task

- **WHEN** an agent reads the apex `llms.txt` wayfinder
- **THEN** it SHALL be directed to the task-appropriate document first, then the matching interface reference

### Requirement: Skill discovery metadata leads with the product, not payment internals

The `SKILL.md` discovery `description` SHALL lead with the full-stack application platform and the free prototype tier / prepaid allowance, and SHALL describe when to use Run402 (build/deploy a web app, database-backed site, API, or project). Payment-rail internals (x402/MPP/Base/Tempo) SHALL appear in the payment section, not the discovery metadata. The discovery digest contract is unchanged (the index digest still equals `sha256(SKILL.md)`).

#### Scenario: Discovery description is product-first

- **WHEN** a host reads the agent-skills discovery `description`
- **THEN** it SHALL lead with the application platform + allowance model, not x402 USDC
