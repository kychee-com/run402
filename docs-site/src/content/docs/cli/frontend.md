---
title: "REST API and user auth for frontends"
description: "What generated frontend code needs: the PostgREST REST API and user auth (password, Google OAuth, tokens)."
order: 10
slice: frontend
summary: "REST API (PostgREST) and user auth for generated frontend code"
---

## REST API (for generated frontend code)

The CLI's `run402 projects rest` command is great for terminal use. But when generating HTML/JS that runs in the browser, use the REST API directly:

Base URL: `https://api.run402.com/rest/v1/{table}`

Auth header: `apikey: {key}` — the gateway auto-forwards as `Authorization: Bearer` to PostgREST. Any valid project JWT works:
- `anon_key` → read-only by default (SELECT). Safe to embed in frontend code. No expiry -- permanent project identifier. If you apply `public_read_write_UNRESTRICTED` RLS to a table, anon_key gains INSERT/UPDATE/DELETE on that table — use this for browser-side writes without login (only on intentionally public tables).
- `service_key` → full admin (bypasses RLS). Server-side only. No expiry -- lease enforcement server-side.
- `access_token` (from login) → user-scoped read/write (subject to RLS).

For explicit control, send both `apikey` (project key) and `Authorization: Bearer <access_token>`.

Dark tables answer with a structured error, not a bare Postgres code: tables are unreadable by anonymous callers through `/rest/v1` until the manifest declares them (`database.expose.tables[]` with `expose: true`). A valid `anon_key` without a user Bearer token against a table that exists but is not exposed gets HTTP 403 `code: "TABLE_NOT_EXPOSED"` (`category: "auth"`, `details: { table, project_id, role: "anon", exists: true, exposed: false }`) with three `next_actions`: `expose_table` (add `{ name, expose: true, policy }` to `database.expose.tables` and `run402 up -y`), `edit_request` (`POST /projects/v1/admin/:project_id/expose` with the service key), or `use_function` (keep it dark and read it from a serverless function with `adminDb()`). It is not an RLS problem — do not go looking for a policy. An RLS denial on an exposed table, a request under a user JWT or the service key, and a table that does not exist (`404 PGRST205`) still pass through from PostgREST unchanged.

CORS: The API allows all origins (`Access-Control-Allow-Origin: *`). Browser `fetch()` calls work from any domain -- no proxy needed.

PostgREST query syntax: `?select=col1,col2`, `?column=eq.value`, `?order=col.desc`, `?limit=N`, `?offset=N`

`Prefer` header (controls write responses):
- `Prefer: return=representation` → return the inserted/updated row(s) as JSON. Use this to get server-generated fields (`id`, `created_at`) without a second query.
- `Prefer: return=minimal` → empty body (default). Faster when you don't need the result.

Frontend fetch examples:

```javascript
// Every Run402 host serves /_run402/config.js: <script src="/_run402/config.js"></script>
const { api_base: API, anon_key: ANON_KEY } = window.RUN402;

// Read rows (public, uses anon_key)
const items = await fetch(API + '/rest/v1/items?select=id,title&done=eq.false&order=id.desc&limit=20', {
  headers: { apikey: ANON_KEY }
}).then(r => r.json());

// Insert a row and get it back (Prefer: return=representation returns the new row with id, created_at, etc.)
const [newItem] = await fetch(API + '/rest/v1/items', {
  method: 'POST',
  headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ title: 'New item', done: false })
}).then(r => r.json());

// Bulk insert — pass an array body
const newItems = await fetch(API + '/rest/v1/items', {
  method: 'POST',
  headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify([{ title: 'Item A', done: false }, { title: 'Item B', done: false }])
}).then(r => r.json());

// Update rows matching a filter
await fetch(API + '/rest/v1/items?id=eq.5', {
  method: 'PATCH',
  headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({ done: true })
}).then(r => r.json());

// Delete rows matching a filter
await fetch(API + '/rest/v1/items?id=eq.5', {
  method: 'DELETE',
  headers: { apikey: ANON_KEY }
});
```

### Complete HTML example

A working single-file app. Uses `public_read_write_UNRESTRICTED` RLS so the `anon_key` handles all reads and writes — no login required. (This template is intentionally open; only apply it to tables where anyone on the internet is allowed to write anything, like guestbooks.)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Guestbook</title>
  <style>
    body { font-family: system-ui; max-width: 480px; margin: 2rem auto; padding: 0 1rem; }
    .entry { border-bottom: 1px solid #eee; padding: 0.5rem 0; }
    .entry .name { font-weight: bold; }
    .entry .time { color: #888; font-size: 0.85em; }
    form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    input { flex: 1; padding: 0.4rem; }
    button { padding: 0.4rem 1rem; }
  </style>
</head>
<body>
  <h1>Guestbook</h1>
  <form id="form">
    <input name="name" placeholder="Your name" required>
    <input name="message" placeholder="Say something..." required>
    <button type="submit">Post</button>
  </form>
  <div id="entries"></div>

  <script>
    // served by the host you are on — never paste a key: <script src="/_run402/config.js"></script> above this block
    const { api_base: API, anon_key: ANON_KEY } = window.RUN402;  // anon_key is public; write-enabled here via public_read_write_UNRESTRICTED RLS

    async function loadEntries() {
      const rows = await fetch(API + '/rest/v1/guestbook?order=created_at.desc&limit=50', {
        headers: { apikey: ANON_KEY }
      }).then(r => r.json());
      document.getElementById('entries').innerHTML = rows.map(r =>
        `<div class="entry"><span class="name">${esc(r.name)}</span> <span class="time">${new Date(r.created_at).toLocaleString()}</span><p>${esc(r.message)}</p></div>`
      ).join('');
    }

    document.getElementById('form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await fetch(API + '/rest/v1/guestbook', {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ name: fd.get('name'), message: fd.get('message') })
      });
      e.target.reset();
      loadEntries();
    };

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    loadEntries();
  </script>
</body>
</html>
```

Setup for this example (run once via CLI or service_key):
```bash
# Create table
run402 projects sql $PROJECT_ID "CREATE TABLE guestbook (id serial PRIMARY KEY, name text NOT NULL, message text NOT NULL, created_at timestamptz DEFAULT now())"

# Expose guestbook so anon_key can insert. Write manifest.json:
# {"version":"1",
#  "tables":[{"name":"guestbook","expose":true,"policy":"public_read_write_UNRESTRICTED","i_understand_this_is_unrestricted":true}],
#  "views":[],"rpcs":[]}
run402 projects apply-expose $PROJECT_ID --file manifest.json
```

---
## User Auth (for apps with login)

Two auth methods: password (email + password) and Google OAuth (social login). Both return the same `access_token` + `refresh_token`. Google OAuth is on for all projects automatically — zero config.

### Password auth

```javascript
// Every Run402 host serves /_run402/config.js: <script src="/_run402/config.js"></script>
const { api_base: API, anon_key: ANON_KEY } = window.RUN402;

// Sign up
await fetch(API + '/auth/v1/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'user@example.com', password: 'secret123' })
});

// Log in (returns access_token + refresh_token)
const session = await fetch(API + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'user@example.com', password: 'secret123' })
}).then(r => r.json());
// session = { access_token, refresh_token, user: { id, email, ... } }
```

Signup does not return an access token. Call `/auth/v1/token` to log in. Returns `access_token` (1h JWT) and `refresh_token` (30d, one-time use).

### Google OAuth (recommended for user-facing apps)

Google sign-in is on for all projects with zero config. When a user signs in with Google, Run402 creates a project-scoped user with their Google name, email, and avatar.

Allowed redirect origins: `http://localhost:*` (any port) + any claimed subdomain (`https://{name}.run402.com`). No manual config needed.

Flow: Frontend generates PKCE verifier + challenge → calls `/auth/v1/oauth/google/start` → navigates to Google → user picks account → Google redirects back to your app with `#code=xxx&state=yyy` → frontend exchanges code for tokens.

Full JavaScript example:

```javascript
// Every Run402 host serves /_run402/config.js: <script src="/_run402/config.js"></script>
const { api_base: API, anon_key: ANON_KEY } = window.RUN402;

// --- PKCE helpers ---
function generateVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function generateChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Step 1: Start login (call on button click) ---
async function signInWithGoogle() {
  const verifier = generateVerifier();
  const challenge = await generateChallenge(verifier);
  localStorage.setItem('pkce_verifier', verifier);

  const res = await fetch(API + '/auth/v1/oauth/google/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({
      redirect_url: window.location.origin + '/',
      mode: 'redirect',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  });
  const { authorization_url } = await res.json();
  window.location.href = authorization_url;  // navigate to Google
}

// --- Step 2: Handle callback (call on page load) ---
async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.hash.substring(1));
  const code = params.get('code');
  if (!code) return false;

  window.history.replaceState(null, '', window.location.pathname);
  const verifier = localStorage.getItem('pkce_verifier');
  localStorage.removeItem('pkce_verifier');

  const res = await fetch(API + '/auth/v1/token?grant_type=authorization_code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });
  const session = await res.json();
  // session = { access_token, refresh_token, user: { id, email, display_name, avatar_url, ... } }
  return session;
}
```

### Using access_token with the REST API

Once a user is logged in, use their `access_token` as the apikey to make user-scoped requests subject to RLS:

```javascript
// User-scoped read/write (subject to RLS policies)
const todos = await fetch(API + '/rest/v1/todos?order=id.desc', {
  headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + session.access_token }
}).then(r => r.json());
```

### Token refresh

```javascript
const refreshed = await fetch(API + '/auth/v1/token?grant_type=refresh_token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ refresh_token: session.refresh_token })
}).then(r => r.json());
```

### Account behavior

- New Google user → new project user created (null password, Google name + avatar stored)
- Returning Google user -> signed in to existing user
- Same email as existing password user → returns `account_exists_requires_link` error (no auto-merge for security)
- Social-only users cannot use password login (helpful error message returned)

### Useful endpoints

- `GET /auth/v1/providers` (with `apikey` header) — list available auth methods (password, google). Useful for dynamic login UIs.
- `GET /auth/v1/user` (with `Authorization: Bearer <access_token>`) — returns `display_name`, `avatar_url`, `email_verified_at`, and linked `identities[]`.

---

## Live changes — push on change, without WebSockets

A page on a run402 host can learn that its data changed without polling. Mark the table live in the expose manifest (`{ "name": "cells", "expose": true, "policy": "public_read_authenticated_write", "live": true }`; `custom` policies are refused), deploy, and subscribe with one line:

```html
<script>
  const es = new EventSource("/_run402/live?tables=cells");
  es.addEventListener("change", (e) => refetch(JSON.parse(e.data)));   // { table, op, pk: [{...}] | null, n }
  es.addEventListener("resync", () => refetchAll());                     // the one rule: handle resync
</script>
```

Hints say *what* changed (table, operation, primary keys), never the row: refetch through `/rest/v1` under your own key, so RLS and the manifest keep deciding what anyone may see. `/_run402/config.json` carries `live: { path: "/_run402/live", tables: [...] }` (or `null`) so a page can build its subscription from the host alone. On a your host the identity is the hosted-auth session cookie (sent by `EventSource` same-origin): a signed-in user receives its own `user_owns_rows` hints; an anonymous page receives public-policy hints only, and a `user_owns_rows` subscription without a session is `401 AUTH_REQUIRED`. The server closes every stream after 300 s with a `reconnect` event and `EventSource` resumes from `Last-Event-ID`; when the gateway cannot promise it saw everything since your cursor it sends `resync` naming your tables instead of inventing a gap. Inside a third-party iframe the cookie is not sent, so a framed page gets the anonymous audience. For callers that cannot hold a stream, `GET /_run402/live/changes?tables=cells&cursor=<c>&wait=25` is the held read. Caps: 200 concurrent live connections per project (50 on prototype); over the cap is `429 LIVE_CONNECTION_LIMIT` with `Retry-After`.

Anonymous REST access requires manifest exposure. Authenticated callers have separate table privileges and remain subject to RLS: an enabled table with no applicable SELECT policy returns `200 []`. Omitting a table from the manifest is not a universal server-only boundary for authenticated users. Enable RLS and define the intended policies for private data; never infer privacy solely from an empty query result.
