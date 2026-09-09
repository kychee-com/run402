---
title: Your first deploy
description: One file and one command take a coding agent from nothing to a live full-stack app on Run402.
order: 0
---

Run402 is a full-stack platform a coding agent provisions, deploys, and pays for on its own: Postgres, REST, auth, storage, functions, and static hosting behind one CLI. A first deploy is **one file and one command**. Everything else — the project, the allowance, the free prototype tier, your name, the rehearsal of database changes — is derived or automatic.

## 1. Install

```bash
npm install -g run402@latest
```

## 2. Write `run402.json`

The manifest is the whole app: a migration, which tables the browser may reach, and the site. Wire fields are `snake_case`.

```json
{
  "$schema": "https://run402.com/schemas/release-spec.v1.json",
  "database": {
    "migrations": [
      { "id": "001_init", "sql": "CREATE TABLE IF NOT EXISTS items (id serial PRIMARY KEY, title text NOT NULL);" }
    ],
    "expose": {
      "version": "1",
      "tables": [{ "name": "items", "expose": true, "policy": "public_read_write_UNRESTRICTED", "i_understand_this_is_unrestricted": true }]
    }
  },
  "site": {
    "replace": {
      "index.html": { "path": "index.html", "content_type": "text/html" }
    }
  }
}
```

`index.html` reads its own keys from the host it is served on — never paste a key into HTML:

```html
<!doctype html>
<script src="/_run402/config.js"></script>
<ul id="items"></ul>
<script type="module">
  const { api_base, anon_key } = window.RUN402;
  const headers = { apikey: anon_key, "Content-Type": "application/json" };
  await fetch(`${api_base}/rest/v1/items`, { method: "POST", headers, body: JSON.stringify({ title: "hello" }) });
  const rows = await fetch(`${api_base}/rest/v1/items`, { headers }).then((r) => r.json());
  document.querySelector("#items").innerHTML = rows.map((r) => `<li>${r.title}</li>`).join("");
</script>
```

`window.RUN402` is `{ project_id, api_base, anon_key }` for whatever project the page was loaded from — a branch copy or a transferred project stays correct without touching the HTML. The anon key is public by design; the service key is never served there.

## 3. Deploy

```bash
run402 up --name my-app -y
```

`up` creates a local allowance and funds it from the testnet faucet (the prototype tier is free), creates the project, sets your display name if you have none (the detected client — `claude-code`, `codex`, `cursor` — or `agent`; change it any time with `run402 org whoami --set-name <name>`), and applies the manifest as one atomic release. Later deploys that change the database against a live project are rehearsed on a throwaway branch first and ship only if they pass; a first deploy has nothing to protect and just ships.

The result is JSON. Hand your human the two links it carries:

```json
{
  "result": {
    "project_id": "prj_…",
    "identity": { "display_name": "claude-code", "source": "detected" },
    "deploy": {
      "status": "ready",
      "urls": { "site": "https://my-app.run402.app", "console": "https://console.run402.com/orgs/…/projects/prj_…" },
      "rehearsal": { "status": "skipped", "reason": "no_live_release" },
      "next_actions": [{ "type": "hand_to_operator", "credited_as": "claude-code", "why": "Show your human the site and the console link…" }]
    }
  }
}
```

That is the whole first run. Run `run402 up -y` again after every change.

## If you were given a promo code

```bash
run402 redeem <code>
```

## Where to go next

- CLI reference: <https://docs.run402.com/llms-cli.txt>
- SDK reference: <https://docs.run402.com/llms-sdk.txt>
- MCP reference: <https://docs.run402.com/llms-mcp.txt>
- Skill: <https://docs.run402.com/SKILL.md>
- HTTP API: <https://run402.com/llms-full.txt>
