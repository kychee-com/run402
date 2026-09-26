# Run402 for Claude

Run402 is full-stack infrastructure an agent can provision on its own: a Postgres database with a REST API, row-level security and user auth, content-addressed storage, static site hosting, Node 22 serverless functions, and email. This plugin lets Claude build, deploy and operate apps on Run402 from a conversation.

## What's in the plugin

- **Skill `run402`**: teaches Claude the Run402 workflow: write a `run402.json` manifest and the app files, run `run402 up` to create and deploy, then verify the live URL. It covers databases and migrations, auth, functions, storage, custom domains and troubleshooting.
- **MCP server `run402`**: the `run402-mcp` npm package, started locally with `npx` at the exact version this plugin release pins. It has eight tools (`up`, `deploy`, `status`, `whoami`, `doctor`, `docs`, `run`, `expand_result`). `run` executes a short TypeScript snippet against the Run402 SDK inside a WebAssembly sandbox with no filesystem, process, or network access of its own.

The MCP server runs where a plugin can start a local command: Claude Code, and Cowork sessions on your computer. On claude.ai chat the skill loads without it.

## Use it

Ask Claude for what you want built, for example:

- "Build a guestbook with a Postgres table and deploy it on Run402."
- "Add email sign-in to my Run402 app and require it for the /admin page."
- "Why is my Run402 function returning 500? Check the logs for the last request."

The first deploy creates a local wallet and a free prototype-tier project. Nothing needs a signup or a cloud dashboard.

## Payments

The prototype tier is free: it is paid once with free testnet USDC from the Run402 faucet, and never expires. Real money is involved only after you put some in, by sending USDC to the wallet address `whoami` reports or by topping up your organization's allowance by card. From then on, paid tiers (hobby $5 and team $20 per 30-day lease, never renewed on their own) and per-call features such as image generation are paid automatically from that balance, with x402 USDC on Base, MPP, or the allowance. Fund only what you are willing to let Claude spend. Prices: https://run402.com.

## Data

The plugin sends the files, SQL, and settings you ask Claude to deploy to the Run402 API at `api.run402.com`, which stores them in your project. The MCP server keeps your wallet key and project keys on your machine under `~/.config/run402` and never sends the wallet key anywhere; requests are signed locally. It reads no conversation history. Privacy policy: https://run402.com/humans/privacy.html. Terms: https://run402.com/humans/terms.html.

## Support

Docs: https://docs.run402.com. Issues: https://github.com/kychee-com/run402/issues. Contact: info@kychee.com.

## License

MIT
