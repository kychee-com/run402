import { findProject, resolveProjectId, API } from "./config.mjs";
import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";

const HELP = `run402 auth — Manage project user authentication

Usage:
  run402 auth <subcommand> [args...]

Subcommands:
  magic-link --email <addr> --redirect <url> [--project <id>]
    Send a passwordless login link. Use --intent invite with a service key-backed project.

  verify --token <token> [--project <id>]
    Exchange a magic link token for access_token + refresh_token.

  create-user --email <addr> [--admin <true|false>] [--invite] [--redirect <url>] [--project <id>]
    Create or update a project auth user with the service key.

  invite-user --email <addr> --redirect <url> [--admin <true|false>] [--project <id>]
    Create/update a user and send a trusted invite magic link.

  set-password --token <bearer> --new <password> [--current <password>] [--project <id>]
    Change, reset, or set a user's password. Requires the user's access_token.

  settings [--allow-password-set <true|false>] [--preferred <method|null>] [--public-signup <policy>] [--require-admin-passkey <true|false>] [--project <id>]
    Update project auth settings (requires service_key).

  passkey-register-options --token <bearer> --app-origin <origin> [--project <id>]
    Create WebAuthn registration options for the authenticated user.

  passkey-register-verify --token <bearer> --challenge <id> --response <json> [--label <text>] [--project <id>]
    Verify and store a passkey registration response.

  passkey-login-options --app-origin <origin> [--email <addr>] [--project <id>]
    Create WebAuthn login options.

  passkey-login-verify --challenge <id> --response <json> [--project <id>]
    Verify a passkey login response and return session tokens.

  passkeys --token <bearer> [--project <id>]
    List the authenticated user's passkeys.

  delete-passkey --token <bearer> --id <passkey_id> [--project <id>]
    Delete one authenticated-user passkey.

  providers [--project <id>]
    List available auth providers for the project.

Examples:
  run402 auth magic-link --email user@example.com --redirect https://myapp.run402.com/cb
  run402 auth verify --token abc123def456
  run402 auth invite-user --email admin@example.com --redirect https://myapp.run402.com/cb --admin true
  run402 auth set-password --token eyJ... --new "new-pass" --current "old-pass"
  run402 auth settings --preferred passkey --require-admin-passkey true
  run402 auth providers
`;

const SUB_HELP = {
  "magic-link": `run402 auth magic-link — Send a passwordless login link

Usage:
  run402 auth magic-link --email <addr> --redirect <url> [options]

Options:
  --email <addr>      Required: recipient email address
  --redirect <url>    Required: URL to redirect to after the user clicks
  --intent <intent>   signin (default), invite, claim, or recovery
  --state <value>     Optional client_state preserved through verification
  --project <id>      Project ID (defaults to active project)

Notes:
  Auto-creates the user on first use. Uses the project's anon_key.

Examples:
  run402 auth magic-link --email user@example.com \\
    --redirect https://myapp.run402.com/cb
`,
  "create-user": `run402 auth create-user — Create or update an auth user

Usage:
  run402 auth create-user --email <addr> [options]

Options:
  --email <addr>      Required: auth user email
  --admin <bool>      Optional: set project_admin status
  --invite            Send a trusted invite magic link
  --redirect <url>    Required when --invite is used
  --state <value>     Optional client_state for the invite
  --project <id>      Project ID (defaults to active project)

Examples:
  run402 auth create-user --email user@example.com
  run402 auth create-user --email admin@example.com --admin true \\
    --invite --redirect https://myapp.run402.com/cb
`,
  "invite-user": `run402 auth invite-user — Send a trusted auth invite

Usage:
  run402 auth invite-user --email <addr> --redirect <url> [options]

Options:
  --email <addr>      Required: auth user email
  --redirect <url>    Required: allowed auth redirect URL
  --admin <bool>      Optional: set project_admin status before inviting
  --state <value>     Optional client_state for the invite
  --project <id>      Project ID (defaults to active project)
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
  run402 auth settings [options]

Options:
  --allow-password-set <true|false>     Toggle password-set flow
  --preferred <method|null>             password, magic_link, oauth_google, passkey, or null
  --public-signup <policy>              open, known_email, or invite_only
  --require-admin-passkey <true|false>  Require passkey auth for project_admin sessions
  --project <id>                        Project ID (defaults to active project)

Notes:
  Requires the project's service_key (admin-level).

Examples:
  run402 auth settings --allow-password-set true
  run402 auth settings --preferred passkey --require-admin-passkey true
`,
  "passkey-register-options": `run402 auth passkey-register-options — Create passkey registration options

Usage:
  run402 auth passkey-register-options --token <bearer> --app-origin <origin> [options]

Options:
  --token <bearer>       Required: authenticated user's access_token
  --app-origin <origin>  Required: exact app origin for WebAuthn
  --project <id>         Project ID (defaults to active project)
`,
  "passkey-register-verify": `run402 auth passkey-register-verify — Verify passkey registration

Usage:
  run402 auth passkey-register-verify --token <bearer> --challenge <id> --response <json> [options]

Options:
  --token <bearer>       Required: authenticated user's access_token
  --challenge <id>       Required: challenge_id returned by passkey-register-options
  --response <json>      Required: browser PublicKeyCredential JSON
  --label <text>         Optional passkey label
  --project <id>         Project ID (defaults to active project)
`,
  "passkey-login-options": `run402 auth passkey-login-options — Create passkey login options

Usage:
  run402 auth passkey-login-options --app-origin <origin> [options]

Options:
  --app-origin <origin>  Required: exact app origin for WebAuthn
  --email <addr>         Optional email hint
  --project <id>         Project ID (defaults to active project)
`,
  "passkey-login-verify": `run402 auth passkey-login-verify — Verify passkey login

Usage:
  run402 auth passkey-login-verify --challenge <id> --response <json> [options]

Options:
  --challenge <id>       Required: challenge_id returned by passkey-login-options
  --response <json>      Required: browser PublicKeyCredential JSON
  --project <id>         Project ID (defaults to active project)
`,
  passkeys: `run402 auth passkeys — List passkeys

Usage:
  run402 auth passkeys --token <bearer> [options]

Options:
  --token <bearer>       Required: authenticated user's access_token
  --project <id>         Project ID (defaults to active project)
`,
  "delete-passkey": `run402 auth delete-passkey — Delete a passkey

Usage:
  run402 auth delete-passkey --token <bearer> --id <passkey_id> [options]

Options:
  --token <bearer>       Required: authenticated user's access_token
  --id <passkey_id>      Required: passkey ID to delete
  --project <id>         Project ID (defaults to active project)
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

function parseOptionalBool(args, flag) {
  const value = parseFlag(args, flag);
  if (value === null) {
    if (args.includes(flag)) {
      fail({ code: "BAD_USAGE", message: `Missing ${flag} <true|false>` });
    }
    return undefined;
  }
  if (value !== "true" && value !== "false") {
    fail({
      code: "BAD_FLAG",
      message: `${flag} must be 'true' or 'false'`,
      hint: "Use the literal strings 'true' or 'false'.",
    });
  }
  return value === "true";
}

function parseJsonFlag(args, flag) {
  const value = parseFlag(args, flag);
  if (!value) {
    fail({ code: "BAD_USAGE", message: `Missing ${flag} <json>` });
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    fail({
      code: "BAD_JSON",
      message: `${flag} must be valid JSON`,
      hint: err instanceof Error ? err.message : undefined,
    });
  }
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
    const intent = parseFlag(args, "--intent");
    if (intent && !["signin", "invite", "claim", "recovery"].includes(intent)) {
      fail({ code: "BAD_FLAG", message: "--intent must be signin, invite, claim, or recovery" });
    }
    const state = parseFlag(args, "--state");
    await getSdk().auth.requestMagicLink(projectId, {
      email,
      redirectUrl: redirect,
      intent: intent ?? undefined,
      clientState: state ?? undefined,
    });
    console.log(JSON.stringify({ status: "ok", email, redirect_url: redirect, intent: intent || "signin" }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function createUser(args) {
  const email = parseFlag(args, "--email");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const isAdmin = parseOptionalBool(args, "--admin");
  const sendInvite = args.includes("--invite");
  const redirectUrl = parseFlag(args, "--redirect");
  const clientState = parseFlag(args, "--state");

  if (!email) {
    fail({ code: "BAD_USAGE", message: "Missing --email" });
  }
  if (sendInvite && !redirectUrl) {
    fail({ code: "BAD_USAGE", message: "Missing --redirect <url> when --invite is used" });
  }

  try {
    const data = await getSdk().auth.createUser(projectId, {
      email,
      isAdmin,
      sendInvite,
      redirectUrl: redirectUrl ?? undefined,
      clientState: clientState ?? undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function inviteUser(args) {
  const email = parseFlag(args, "--email");
  const redirectUrl = parseFlag(args, "--redirect");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const isAdmin = parseOptionalBool(args, "--admin");
  const clientState = parseFlag(args, "--state");

  if (!email) {
    fail({ code: "BAD_USAGE", message: "Missing --email" });
  }
  if (!redirectUrl) {
    fail({ code: "BAD_USAGE", message: "Missing --redirect <url>" });
  }

  try {
    const data = await getSdk().auth.inviteUser(projectId, {
      email,
      redirectUrl,
      isAdmin,
      clientState: clientState ?? undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...data }));
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
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  const allow = parseOptionalBool(args, "--allow-password-set");
  const requireAdminPasskey = parseOptionalBool(args, "--require-admin-passkey");
  const preferredRaw = parseFlag(args, "--preferred");
  const publicSignup = parseFlag(args, "--public-signup");

  if (
    allow === undefined &&
    requireAdminPasskey === undefined &&
    preferredRaw === null &&
    publicSignup === null
  ) {
    fail({
      code: "BAD_USAGE",
      message: "Set at least one auth setting flag",
    });
  }
  if (
    preferredRaw !== null &&
    !["password", "magic_link", "oauth_google", "passkey", "null"].includes(preferredRaw)
  ) {
    fail({
      code: "BAD_FLAG",
      message: "--preferred must be password, magic_link, oauth_google, passkey, or null",
    });
  }
  if (publicSignup !== null && !["open", "known_email", "invite_only"].includes(publicSignup)) {
    fail({
      code: "BAD_FLAG",
      message: "--public-signup must be open, known_email, or invite_only",
    });
  }

  try {
    const patch = {
      allow_password_set: allow,
      preferred_sign_in_method: preferredRaw === "null" ? null : preferredRaw ?? undefined,
      public_signup: publicSignup ?? undefined,
      require_passkey_for_project_admin: requireAdminPasskey,
    };
    const data = await getSdk().auth.settings(projectId, patch);
    console.log(JSON.stringify({ status: "ok", ...patch, ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function passkeyRegisterOptions(args) {
  const accessToken = parseFlag(args, "--token");
  const appOrigin = parseFlag(args, "--app-origin");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  if (!accessToken) fail({ code: "BAD_USAGE", message: "Missing --token <bearer_token>" });
  if (!appOrigin) fail({ code: "BAD_USAGE", message: "Missing --app-origin <origin>" });
  try {
    const data = await getSdk().auth.createPasskeyRegistrationOptions(projectId, {
      accessToken,
      appOrigin,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function passkeyRegisterVerify(args) {
  const accessToken = parseFlag(args, "--token");
  const challengeId = parseFlag(args, "--challenge");
  const label = parseFlag(args, "--label");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  if (!accessToken) fail({ code: "BAD_USAGE", message: "Missing --token <bearer_token>" });
  if (!challengeId) fail({ code: "BAD_USAGE", message: "Missing --challenge <id>" });
  const response = parseJsonFlag(args, "--response");
  try {
    const data = await getSdk().auth.verifyPasskeyRegistration(projectId, {
      accessToken,
      challengeId,
      response,
      label: label ?? undefined,
    });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function passkeyLoginOptions(args) {
  const appOrigin = parseFlag(args, "--app-origin");
  const email = parseFlag(args, "--email");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  if (!appOrigin) fail({ code: "BAD_USAGE", message: "Missing --app-origin <origin>" });
  try {
    const data = await getSdk().auth.createPasskeyLoginOptions(projectId, {
      appOrigin,
      email: email ?? undefined,
    });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function passkeyLoginVerify(args) {
  const challengeId = parseFlag(args, "--challenge");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  if (!challengeId) fail({ code: "BAD_USAGE", message: "Missing --challenge <id>" });
  const response = parseJsonFlag(args, "--response");
  try {
    const data = await getSdk().auth.verifyPasskeyLogin(projectId, {
      challengeId,
      response,
    });
    console.log(JSON.stringify({ status: "ok", ...data }));
  } catch (err) {
    reportSdkError(err);
  }
}

async function passkeys(args) {
  const accessToken = parseFlag(args, "--token");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  if (!accessToken) fail({ code: "BAD_USAGE", message: "Missing --token <bearer_token>" });
  try {
    const data = await getSdk().auth.listPasskeys(projectId, { accessToken });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    reportSdkError(err);
  }
}

async function deletePasskey(args) {
  const accessToken = parseFlag(args, "--token");
  const passkeyId = parseFlag(args, "--id");
  const projectId = resolveProjectId(parseFlag(args, "--project"));
  if (!accessToken) fail({ code: "BAD_USAGE", message: "Missing --token <bearer_token>" });
  if (!passkeyId) fail({ code: "BAD_USAGE", message: "Missing --id <passkey_id>" });
  try {
    await getSdk().auth.deletePasskey(projectId, {
      accessToken,
      passkeyId,
    });
    console.log(JSON.stringify({ status: "ok", passkey_id: passkeyId }));
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
    case "create-user": await createUser(args); break;
    case "invite-user": await inviteUser(args); break;
    case "set-password": await setPassword(args); break;
    case "settings": await settings(args); break;
    case "passkey-register-options": await passkeyRegisterOptions(args); break;
    case "passkey-register-verify": await passkeyRegisterVerify(args); break;
    case "passkey-login-options": await passkeyLoginOptions(args); break;
    case "passkey-login-verify": await passkeyLoginVerify(args); break;
    case "passkeys": await passkeys(args); break;
    case "delete-passkey": await deletePasskey(args); break;
    case "providers": await providers(args); break;
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
