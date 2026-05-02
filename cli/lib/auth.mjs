import { findProject, resolveProjectId, API } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 auth — Manage project user authentication

Usage:
  run402 auth <subcommand> [args...]

Subcommands:
  magic-link --email <addr> --redirect <url> [--project <id>]
    Send a passwordless login link to the given email. Auto-creates user on first use.

  verify --token <token> [--project <id>]
    Exchange a magic link token for access_token + refresh_token.

  set-password --token <bearer> --new <password> [--current <password>] [--project <id>]
    Change, reset, or set a user's password. Requires the user's access_token.

  settings --allow-password-set <true|false> [--project <id>]
    Update project auth settings (requires service_key).

  providers [--project <id>]
    List available auth providers for the project.

Examples:
  run402 auth magic-link --email user@example.com --redirect https://myapp.run402.com/cb
  run402 auth verify --token abc123def456
  run402 auth set-password --token eyJ... --new "new-pass" --current "old-pass"
  run402 auth settings --allow-password-set true
  run402 auth providers
`;

const SUB_HELP = {
  "magic-link": `run402 auth magic-link — Send a passwordless login link

Usage:
  run402 auth magic-link --email <addr> --redirect <url> [options]

Options:
  --email <addr>      Required: recipient email address
  --redirect <url>    Required: URL to redirect to after the user clicks
  --project <id>      Project ID (defaults to active project)

Notes:
  Auto-creates the user on first use. Uses the project's anon_key.

Examples:
  run402 auth magic-link --email user@example.com \\
    --redirect https://myapp.run402.com/cb
`,
  verify: `run402 auth verify — Exchange a magic-link token for session tokens

Usage:
  run402 auth verify --token <token> [options]

Options:
  --token <token>     Required: the one-time magic-link token
  --project <id>      Project ID (defaults to active project)

Notes:
  Returns an access_token + refresh_token pair on success.

Examples:
  run402 auth verify --token abc123def456
`,
  "set-password": `run402 auth set-password — Change, reset, or set a user's password

Usage:
  run402 auth set-password --token <bearer> --new <password> [options]

Options:
  --token <bearer>    Required: the user's access_token (Bearer token)
  --new <password>    Required: new password
  --current <pwd>     Current password (required when one is already set)
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 auth set-password --token eyJ... --new "new-pass" \\
    --current "old-pass"
`,
  settings: `run402 auth settings — Update project auth settings

Usage:
  run402 auth settings --allow-password-set <true|false> [options]

Options:
  --allow-password-set <true|false>  Required: toggle password-set flow
  --project <id>                     Project ID (defaults to active project)

Notes:
  Requires the project's service_key (admin-level).

Examples:
  run402 auth settings --allow-password-set true
  run402 auth settings --allow-password-set false --project prj_abc123
`,
  providers: `run402 auth providers — List available auth providers

Usage:
  run402 auth providers [options]

Options:
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 auth providers
  run402 auth providers --project prj_abc123
`,
};

function parseFlag(args, flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
  }
  return null;
}

async function magicLink(args) {
  const email = parseFlag(args, "--email");
  const redirect = parseFlag(args, "--redirect");
  const projectId = resolveProjectId(parseFlag(args, "--project"));

  if (!email) {
    fail({ code: "BAD_USAGE", message: "Missing --email" });
  }
  if (!redirect) {
    fail({ code: "BAD_USAGE", message: "Missing --redirect <url>" });
  }

  try {
    await getSdk().auth.requestMagicLink(projectId, { email, redirectUrl: redirect });
    console.log(JSON.stringify({ status: "ok", email, redirect_url: redirect }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function verify(args) {
  const token = parseFlag(args, "--token");
  const projectId = resolveProjectId(parseFlag(args, "--project"));

  if (!token) {
    fail({ code: "BAD_USAGE", message: "Missing --token" });
  }

  try {
    const data = await getSdk().auth.verifyMagicLink(projectId, token);
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function setPassword(args) {
  const accessToken = parseFlag(args, "--token");
  const newPassword = parseFlag(args, "--new");
  const currentPassword = parseFlag(args, "--current");
  const projectId = resolveProjectId(parseFlag(args, "--project"));

  if (!accessToken) {
    fail({ code: "BAD_USAGE", message: "Missing --token <bearer_token>" });
  }
  if (!newPassword) {
    fail({ code: "BAD_USAGE", message: "Missing --new <password>" });
  }

  try {
    await getSdk().auth.setUserPassword(projectId, {
      accessToken,
      newPassword,
      currentPassword: currentPassword ?? undefined,
    });
    console.log(JSON.stringify({ status: "ok" }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function settings(args) {
  const allowPasswordSet = parseFlag(args, "--allow-password-set");
  const projectId = resolveProjectId(parseFlag(args, "--project"));

  if (allowPasswordSet === null) {
    fail({
      code: "BAD_USAGE",
      message: "Missing --allow-password-set <true|false>",
    });
  }

  try {
    await getSdk().auth.settings(projectId, { allow_password_set: allowPasswordSet === "true" });
    console.log(JSON.stringify({ status: "ok", allow_password_set: allowPasswordSet === "true" }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function providers(args) {
  // `providers` isn't in the pilot SDK surface — keep the direct fetch.
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  const res = await fetch(`${API}/auth/v1/providers`, {
    headers: {
      "apikey": p.anon_key,
      "Authorization": `Bearer ${p.anon_key}`,
    },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

export async function run(sub, args) {
  if (!sub || sub === "--help" || sub === "-h") { console.log(HELP); process.exit(0); }
  if (Array.isArray(args) && (args.includes("--help") || args.includes("-h"))) {
    console.log(SUB_HELP[sub] || HELP);
    process.exit(0);
  }
  switch (sub) {
    case "magic-link": await magicLink(args); break;
    case "verify": await verify(args); break;
    case "set-password": await setPassword(args); break;
    case "settings": await settings(args); break;
    case "providers": await providers(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
