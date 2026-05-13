import { fail } from "./sdk-errors.mjs";

const HELP = `run402 deploy — Unified deploy operations

Usage:
  run402 deploy <subcommand> [options]

Subcommands:
  apply --manifest <file>       Apply a v2 ReleaseSpec manifest
  resume <operation_id>         Resume a stuck operation
  list [--project <id>]         List recent deploy operations
  events <operation_id>         Fetch event stream for an operation
  diagnose <url>                Diagnose public URL routing
  resolve --url <url>           Low-level resolve diagnostics
  release ...                   Inspect release inventory and diffs

Examples:
  run402 deploy apply --manifest app.json
  run402 deploy resume op_123
  run402 deploy release active --project prj_123

Manifest sketch:
  {
    "database": {
      "migrations": [{ "id": "001_init", "sql_path": "schema.sql" }]
    },
    "site": {
      "replace": { "index.html": { "path": "dist/index.html" } }
    },
    "functions": {
      "replace": {
        "api": {
          "runtime": "node22",
          "source": { "path": "api.mjs" }
        }
      }
    },
    "secrets": { "require": ["OPENAI_API_KEY"] },
    "subdomains": { "set": ["my-app"] }
  }
`;

export async function run(args) {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  switch (sub) {
    case "apply":
    case "resume":
    case "list":
    case "events":
    case "diagnose":
    case "resolve":
    case "release": {
      const { runDeployV2 } = await import("./deploy-v2.mjs");
      await runDeployV2(sub, args.slice(1));
      return;
    }
    default:
      fail({
        code: "BAD_USAGE",
        message: `Unknown deploy subcommand: ${sub}`,
        hint: "Use `run402 deploy apply --manifest <file>` for deployments.",
        details: { subcommand: sub },
      });
  }
}
