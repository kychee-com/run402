import { findProject, resolveProjectId, API } from "./config.mjs";

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
  run402 auth settings --allow-password-set false --project abc123
`,
  providers: `run402 auth providers — List available auth providers

Usage:
  run402 auth providers [options]

Options:
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 auth providers
  run402 auth providers --project abc123
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
  const p = findProject(projectId);

  if (!email) { console.error(JSON.stringify({ status: "error", message: "Missing --email" })); process.exit(1); }
  if (!redirect) { console.error(JSON.stringify({ status: "error", message: "Missing --redirect <url>" })); process.exit(1); }

  const res = await fetch(`${API}/auth/v1/magic-link`, {
    method: "POST",
    headers: {
      "apikey": p.anon_key,
      "Authorization": `Bearer ${p.anon_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, redirect_url: redirect }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ok", ...data }));
}

async function verify(args) {
  const token = parseFlag(args, "--token");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  if (!token) { console.error(JSON.stringify({ status: "error", message: "Missing --token" })); process.exit(1); }

  const res = await fetch(`${API}/auth/v1/token?grant_type=magic_link`, {
    method: "POST",
    headers: {
      "apikey": p.anon_key,
      "Authorization": `Bearer ${p.anon_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ok", ...data }));
}

async function setPassword(args) {
  const accessToken = parseFlag(args, "--token");
  const newPassword = parseFlag(args, "--new");
  const currentPassword = parseFlag(args, "--current");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  if (!accessToken) { console.error(JSON.stringify({ status: "error", message: "Missing --token <bearer_token>" })); process.exit(1); }
  if (!newPassword) { console.error(JSON.stringify({ status: "error", message: "Missing --new <password>" })); process.exit(1); }

  const body = { new_password: newPassword };
  if (currentPassword) body.current_password = currentPassword;

  // /auth/v1/* is gated by apikeyAuth middleware: the `apikey` header must be
  // the project's anon_key. `Authorization: Bearer <access_token>` stays as
  // the user's identity so the server knows whose password to change.
  const res = await fetch(`${API}/auth/v1/user/password`, {
    method: "PUT",
    headers: {
      "apikey": p.anon_key,
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ok", ...data }));
}

async function settings(args) {
  const allowPasswordSet = parseFlag(args, "--allow-password-set");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const p = findProject(projectId);

  if (allowPasswordSet === null) { console.error(JSON.stringify({ status: "error", message: "Missing --allow-password-set <true|false>" })); process.exit(1); }

  const res = await fetch(`${API}/auth/v1/settings`, {
    method: "PATCH",
    headers: {
      "apikey": p.anon_key,
      "Authorization": `Bearer ${p.service_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ allow_password_set: allowPasswordSet === "true" }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify({ status: "error", http: res.status, ...data }));
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "ok", ...data }));
}

async function providers(args) {
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
