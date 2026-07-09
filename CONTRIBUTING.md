# Contributing to run402

Questions, bugs, and ideas all start as a [GitHub issue](https://github.com/kychee-com/run402/issues); issues are our contact desk and we read them. For security vulnerabilities, do not open a public issue: see [SECURITY.md](./SECURITY.md).

## Pull requests

- Small, focused PRs land fastest. For anything bigger than a fix, open an issue first so we can agree on direction before you spend the time.
- This monorepo keeps every surface (MCP tools, CLI subcommands, OpenClaw scripts) a thin shim over `@run402/sdk`, and `npm run test:sync` enforces that they stay in sync. If you add or change a surface, update its siblings; [documentation.md](./documentation.md) maps which docs each change must touch.

## Development

```bash
npm run build           # builds core/, sdk/, then the MCP server
npm test                # SKILL + sync + unit tests
npm run test:e2e        # CLI end-to-end tests
npm run test:sync       # checks MCP/CLI/OpenClaw/SDK stay in sync
```

## Licensing

This repo is MIT; the full backend, [`run402-core`](https://github.com/kychee-com/run402-core), is Apache-2.0. By submitting a contribution you agree it is licensed under this repo's license.
