# docs.run402.com — documentation portal

Static [Astro Starlight](https://starlight.astro.build/) site for the developer
supervising a Run402 agent. Deployed to the existing run402 docs project
(`prj_1780488560350_0018`) by `.github/workflows/deploy-docs.yml` via GitHub OIDC.

## Single source of truth

The agent-facing flat references are **generated** from this portal's content —
edit the content here, never the `.txt` files:

| Edit this (canonical source) | Regenerates (committed, served at) |
| --- | --- |
| `src/content/docs/cli/**` | `../cli/llms-cli.txt` → `docs.run402.com/llms-cli.txt` |
| `src/content/docs/sdk/**` | `../sdk/llms-sdk.txt` → `docs.run402.com/llms-sdk.txt` |
| `src/content/docs/mcp/**` | `../llms-mcp.txt` → `docs.run402.com/llms-mcp.txt` |

A page joins a bundle by living under its section directory; pages within a
bundle are ordered by the frontmatter `order` field. Portal-only pages
(`index.mdx`, `getting-started.md`, `reference/error-codes.md`) feed no flat file.

```sh
node ../scripts/build-agent-flat-docs.mjs          # regenerate after editing content
node ../scripts/build-agent-flat-docs.mjs --check   # CI gate: fails if committed flat files are stale
```

> `SKILL.md` is **not** generated here. Its agent-skills YAML frontmatter is part
> of the discovery-index digest, so it stays authored at the repo root.

## Develop & build

```sh
npm install
npm run dev      # local preview at http://localhost:4321
npm run build    # static output to dist/
```

## Deploy

CI builds `dist/`, then `../scripts/build-docs-deploy-manifest.mjs` enumerates it
(plus the four root flat files) into `../run402.docs.deploy.json`, which is fed to
`run402 deploy apply`. Static only — no `@run402/astro` SSR adapter.
