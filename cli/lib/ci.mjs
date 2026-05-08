import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CI_GITHUB_ACTIONS_PROVIDER,
  DEFAULT_CI_DELEGATION_CHAIN_ID,
  V1_CI_ALLOWED_ACTIONS,
  V1_CI_ALLOWED_EVENTS_DEFAULT,
  signCiDelegation,
} from "#sdk/node";
import { API, resolveProjectId } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const { version: RUN402_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const HELP = `run402 ci — Manage CI/OIDC deploy bindings

Usage:
  run402 ci link github [--project <id>] [--manifest <path>] [--repo <owner/repo>] [--branch <name> | --environment <name>] [--repository-id <id>] [--workflow <path>] [--expires-at <iso>] [--route-scope <pattern> ...] [--force]
  run402 ci list [--project <id>]
  run402 ci revoke <binding_id>

Subcommands:
  link github   Link this repo/branch or environment for GitHub Actions deploys
  list          List CI bindings for a project
  revoke        Revoke a CI binding
`;

const SUB_HELP = {
  link: `run402 ci link github — Link GitHub Actions OIDC for deploy apply

Usage:
  run402 ci link github [--project <id>] [--manifest <path>] [--repo <owner/repo>] [--branch <name> | --environment <name>] [--repository-id <id>] [--workflow <path>] [--expires-at <iso>] [--route-scope <pattern> ...] [--force]

Options:
  --project <id>          Project ID (defaults to the active project)
  --manifest <path>       Manifest path used by the generated workflow (default: run402.deploy.json)
  --repo <owner/repo>     GitHub repo (default: inferred from origin remote)
  --branch <name>         Branch subject and push trigger (default: current branch)
  --environment <name>    GitHub environment subject; adds job.environment
  --repository-id <id>    Numeric GitHub repository id when API lookup is unavailable
  --workflow <path>       Workflow path (default: .github/workflows/run402-deploy.yml)
  --expires-at <iso>      Optional binding expiration timestamp
  --route-scope <pattern> Optional exact path or final wildcard route scope, repeatable (examples: /admin, /api/*)
  --force                 Overwrite an existing workflow file

Notes:
  - v1 allows only push and workflow_dispatch events.
  - Without --route-scope, CI cannot deploy route declarations.
  - Route scopes delegate only matching public path changes; secrets, subdomains, checks, and non-current base remain local-only.
  - v1 does not expose raw subject, wildcard, or pull-request deploy flags.
`,
  list: `run402 ci list — List CI bindings

Usage:
  run402 ci list [--project <id>]
`,
  revoke: `run402 ci revoke — Revoke a CI binding

Usage:
  run402 ci revoke <binding_id>
`,
};

function parseFlags(args, allowed, { repeatable = new Set() } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!allowed.has(arg)) {
      fail({
        code: "BAD_USAGE",
        message: `Unsupported flag: ${arg}`,
        hint: "Run: run402 ci link github --help",
        details: { flag: arg },
      });
    }
    if (arg === "--force") {
      flags.force = true;
      continue;
    }
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      fail({
        code: "BAD_USAGE",
        message: `Missing value for ${arg}.`,
        details: { flag: arg },
      });
    }
    const key = arg.slice(2).replace(/-/g, "_");
    const value = args[++i];
    if (repeatable.has(arg)) {
      flags[key] ??= [];
      flags[key].push(value);
      continue;
    }
    flags[key] = value;
  }
  return { flags, positional };
}

function rejectHighRiskFlags(args) {
  const blocked = [
    "--subject",
    "--subject-match",
    "--wildcard",
    "--allow-event",
    "--event",
    "--pull-request",
    "--pr",
    "--no-repository-id",
  ];
  const hit = args.find((arg) => blocked.includes(arg));
  if (hit) {
    fail({
      code: "UNSUPPORTED_CI_FLAG",
      message: `${hit} is intentionally not exposed by run402 ci link github v1.`,
      hint: "Use --branch or --environment. PR deploys, raw subjects, wildcards, and soft repository-id binding are deferred.",
      details: { flag: hit },
    });
  }
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function inferRepo() {
  const remote = git(["remote", "get-url", "origin"]);
  if (!remote) return null;
  return parseGithubRemote(remote);
}

function parseGithubRemote(remote) {
  const cleaned = remote.trim().replace(/\.git$/, "");
  const ssh = cleaned.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = cleaned.match(/^https:\/\/github\.com\/([^/]+)\/(.+)$/);
  if (https) return `${https[1]}/${https[2]}`;
  const sshUrl = cleaned.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/);
  if (sshUrl) return `${sshUrl[1]}/${sshUrl[2]}`;
  return null;
}

function inferBranch() {
  return git(["branch", "--show-current"]);
}

async function fetchGithubRepositoryId(repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "run402-cli",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  } catch {
    return null;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || typeof body?.id !== "number") return null;
  return String(body.id);
}

function buildSubject(repo, { branch, environment }) {
  if (environment) return `repo:${repo}:environment:${environment}`;
  if (!branch) {
    fail({
      code: "CI_SUBJECT_REQUIRED",
      message: "Could not infer a branch for the GitHub Actions subject.",
      hint: "Pass --branch <name> or --environment <name>.",
    });
  }
  return `repo:${repo}:ref:refs/heads/${branch}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function generateWorkflow({ branch, environment, manifest, projectId }) {
  const pushBlock = branch
    ? `  push:\n    branches: [${yamlString(branch)}]\n`
    : `  push:\n`;
  const environmentLine = environment ? `    environment: ${yamlString(environment)}\n` : "";
  return `name: Run402 Deploy

on:
${pushBlock}  workflow_dispatch:

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
${environmentLine}    steps:
      - uses: actions/checkout@v4
      - name: Deploy to run402
        run: npx --yes run402@${RUN402_VERSION} deploy apply --manifest ${shellQuote(manifest)} --project ${shellQuote(projectId)}
`;
}

async function linkGithub(args) {
  rejectHighRiskFlags(args);
  const { flags, positional } = parseFlags(args, new Set([
    "--project",
    "--manifest",
    "--repo",
    "--branch",
    "--environment",
    "--repository-id",
    "--workflow",
    "--expires-at",
    "--route-scope",
    "--force",
  ]), { repeatable: new Set(["--route-scope"]) });
  if (positional[0] !== "github" || positional.length > 1) {
    fail({
      code: "BAD_USAGE",
      message: "Missing provider: github.",
      hint: "run402 ci link github [--project <id>]",
    });
  }
  if (flags.branch && flags.environment) {
    fail({
      code: "BAD_USAGE",
      message: "Choose either --branch or --environment, not both.",
    });
  }

  const projectId = resolveProjectId(flags.project);
  const repo = flags.repo || inferRepo();
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    fail({
      code: "GITHUB_REPO_REQUIRED",
      message: "Could not infer GitHub owner/repo from git remote origin.",
      hint: "Pass --repo <owner/repo>.",
    });
  }
  const branch = flags.environment ? (flags.branch || inferBranch() || null) : (flags.branch || inferBranch());
  const subject = buildSubject(repo, { branch, environment: flags.environment });
  const repositoryId = flags.repository_id || await fetchGithubRepositoryId(repo);
  if (!repositoryId) {
    fail({
      code: "GITHUB_REPOSITORY_ID_REQUIRED",
      message: `Could not fetch the numeric GitHub repository id for ${repo}.`,
      hint: "Set GITHUB_TOKEN/GH_TOKEN or pass --repository-id <id>.",
      details: { repo },
    });
  }

  const workflowPath = flags.workflow || ".github/workflows/run402-deploy.yml";
  const absWorkflowPath = resolve(process.cwd(), workflowPath);
  if (existsSync(absWorkflowPath) && !flags.force) {
    fail({
      code: "WORKFLOW_EXISTS",
      message: `Workflow already exists: ${workflowPath}`,
      hint: "Pass --force to overwrite it.",
      details: { workflow_path: workflowPath },
    });
  }

  const manifest = flags.manifest || "run402.deploy.json";
  const routeScopes = Array.isArray(flags.route_scope) ? flags.route_scope : [];
  const nonce = randomBytes(16).toString("hex");
  const values = {
    project_id: projectId,
    subject_match: subject,
    allowed_actions: V1_CI_ALLOWED_ACTIONS,
    allowed_events: V1_CI_ALLOWED_EVENTS_DEFAULT,
    route_scopes: routeScopes,
    github_repository_id: repositoryId,
    expires_at: flags.expires_at || null,
    nonce,
  };

  let signedDelegation;
  try {
    signedDelegation = signCiDelegation(values, { apiBase: API });
  } catch (err) {
    fail({
      code: "NO_ALLOWANCE",
      message: err?.message || "No local allowance configured.",
      hint: "Run: run402 init",
    });
  }

  const workflow = generateWorkflow({
    branch,
    environment: flags.environment || null,
    manifest,
    projectId,
  });

  try {
    const binding = await getSdk({ disablePaidFetch: true }).ci.createBinding({
      ...values,
      provider: CI_GITHUB_ACTIONS_PROVIDER,
      signed_delegation: signedDelegation,
    });
    const outputRouteScopes = Array.isArray(binding.route_scopes) ? binding.route_scopes : [];
    mkdirSync(dirname(absWorkflowPath), { recursive: true });
    writeFileSync(absWorkflowPath, workflow, { encoding: "utf8", mode: 0o644 });
    console.log(JSON.stringify({
      status: "ok",
      binding_id: binding.id,
      project_id: projectId,
      provider: CI_GITHUB_ACTIONS_PROVIDER,
      subject_match: subject,
      allowed_events: [...V1_CI_ALLOWED_EVENTS_DEFAULT],
      allowed_actions: [...V1_CI_ALLOWED_ACTIONS],
      route_scopes: outputRouteScopes,
      github_repository_id: repositoryId,
      github_repository_id_status: flags.repository_id ? "provided" : "verified",
      workflow_path: workflowPath,
      manifest_path: manifest,
      run402_version: RUN402_VERSION,
      delegation_chain_id: DEFAULT_CI_DELEGATION_CHAIN_ID,
      bootstrap_caveat: "Commit the generated workflow and manifest before expecting GitHub Actions deploys.",
      consent_summary: [
        "This binding lets matching GitHub Actions workflows deploy site, function, and database changes to the project.",
        outputRouteScopes.length > 0
          ? `It may deploy route declarations only within: ${outputRouteScopes.join(", ")}.`
          : "It cannot deploy route declarations unless you re-link with --route-scope.",
        "It does not allow direct secrets, domains, subdomains, lifecycle, billing, contracts, or faucet API calls.",
      ],
      revocation_residuals: [
        "Revocation stops future CI gateway requests.",
        "Revocation does not undo already-deployed code, stop in-flight deploy operations, rotate exfiltrated keys, or remove deployed functions.",
      ],
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function list(args) {
  const { flags } = parseFlags(args, new Set(["--project"]));
  const project = resolveProjectId(flags.project);
  try {
    const result = await getSdk({ disablePaidFetch: true }).ci.listBindings({ project });
    console.log(JSON.stringify({ status: "ok", project_id: project, ...result }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function revoke(args) {
  const bindingId = args.find((arg) => !arg.startsWith("--"));
  if (!bindingId) {
    fail({
      code: "BAD_USAGE",
      message: "Missing <binding_id>.",
      hint: "run402 ci revoke <binding_id>",
    });
  }
  try {
    const binding = await getSdk({ disablePaidFetch: true }).ci.revokeBinding(bindingId);
    console.log(JSON.stringify({
      status: "ok",
      binding,
      revocation_residuals: [
        "Revocation stops future CI gateway requests.",
        "Revocation does not undo already-deployed code, stop in-flight deploy operations, rotate exfiltrated keys, or remove deployed functions.",
      ],
    }, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(HELP);
    process.exit(0);
  }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "link": await linkGithub(args); break;
    case "list": await list(args); break;
    case "revoke": await revoke(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
