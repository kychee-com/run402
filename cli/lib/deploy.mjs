import { failUnknownSubcommand } from "./argparse.mjs";

/**
 * `run402 deploy` is the one word that is both a verb and a family: bare
 * `run402 deploy [--manifest <path>] [--project <project_id>] …` performs the
 * deploy, and `run402 deploy <subcommand>` dispatches the family. Every
 * subcommand and the deploy itself live in deploy-v2.mjs; this file only
 * decides which one the argv names.
 */

export async function run(args) {
  const sub = args[0];
  const { runDeployV2 } = await import("./deploy-v2.mjs");

  switch (sub) {
    case "rehearse":
    case "promote":
    case "resume":
    case "status":
    case "list":
    case "events":
    case "verify":
    case "resolve":
    case "releases":
      await runDeployV2(sub, args.slice(1));
      return;
    default:
      break;
  }

  // A bare word that is not a subcommand is a typo, never a manifest: the
  // deploy takes no positionals. Everything else — no arguments at all, a
  // flag, --help — is the deploy itself.
  if (typeof sub === "string" && !sub.startsWith("-")) {
    failUnknownSubcommand("deploy", sub, {
      hint: "Use `run402 deploy --manifest <path>` to deploy, or one of the subcommands.",
    });
  }
  await runDeployV2("deploy", args);
}
