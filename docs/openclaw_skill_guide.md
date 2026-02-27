# How to Build & Publish a Run402 OpenClaw Skill + MCP Server

*Source: GPT-5.2 Pro consultation, 2026-02-27*

---

## 0) The "build once, ship everywhere" approach

Don't implement two separate integrations.

Build a **single tool server** (your MCP server) that exposes the 5 high‑level tools:

- `provision_postgres_project`
- `run_sql`
- `rest_query`
- `upload_file`
- `renew_project`

Then publish it in two ways:

1) **OpenClaw skill listing** that runs `npx @run402/mcp` (or points to your Docker image)
2) **MCP server package** (`@run402/mcp`) that any MCP-capable agent runtime can install

This keeps behavior identical across ecosystems, and all docs/examples refer to the same thing.

---

## 1) OpenClaw skill format/spec (and how skills work technically)

I don't have an authoritative OpenClaw/ClawHub spec in my training data (it may be newer or evolving). What *is* stable across modern "skills" systems (and what OpenClaw is very likely doing) is:

### How skills work (technical model)
- A "skill" is a **tool provider**.
- OpenClaw loads the skill's **manifest** (metadata + tool schemas + how to run it).
- When the model chooses a tool call, OpenClaw:
  1) validates args against the tool schema
  2) invokes the skill runtime (in‑process module, subprocess, container, or remote HTTP)
  3) returns the structured result to the model

### What a skill typically contains
1) **Manifest file** (JSON/YAML) with:
   - name/slug/version/license/repo
   - install/run instructions (command, docker, etc.)
   - required env vars/secrets
   - tool definitions (JSON Schema for inputs; sometimes outputs)
2) **Implementation**:
   - Node/Python binary or module that handles tool invocations and returns JSON

### The practical way to get the exact OpenClaw spec (fast)
Because field names differ by ecosystem, do this first:

1) Open 3–5 popular skills already listed in ClawHub
2) Copy their manifest structure (exact keys, schema version, required fields)
3) If OpenClaw provides a CLI, run its validator (usually something like `openclaw skill validate`)

If you paste me **one example skill manifest** from ClawHub (or a link), I can rewrite the templates below to match it exactly.

### Safe assumption that will likely make this trivial
Many runtimes now treat **MCP servers as skills**. If OpenClaw supports "MCP skills", your OpenClaw "skill" is just:
- a listing entry + env var schema
- a run command: `npx @run402/mcp`

So even if the OpenClaw manifest differs, the *implementation* remains your MCP server.

---

## 2) Step-by-step: build the Run402 OpenClaw skill (tools + behavior)

### Step 2.1 — Create a public repo (recommended)
Create `run402/agent-tools` (public). Keep it separate from your service monorepo so discovery + installs are clean.

Suggested structure:
```
agent-tools/
  packages/
    client/          # shared Run402 HTTP client + key store
    mcp/             # MCP server (published as @run402/mcp)
  README.md
  LICENSE
```

### Step 2.2 — Implement a tiny shared client (`@run402/client`)
This client should:
- know `apiBase` (default `https://api.run402.com`)
- manage a **project key store** (so tools can accept `project_id` only)
- normalize errors, especially **payment required / insufficient funds**

**Key store (minimal but effective):**
- file: `~/.config/run402/projects.json` (override by env var)
- map: `project_id -> { anon_key, service_key, tier?, expires_at? }`
- enforce file perms (0600) if possible

### Step 2.3 — Define the 5 tools (schemas + exact semantics)

Below are tool *contracts* that work well for agents. (You can implement identical schemas in OpenClaw + MCP.)

#### Tool: `provision_postgres_project`
**Input**
- `tier`: `"prototype" | "hobby" | "team"` (default `"prototype"`)
- optional `label`: string (useful for humans)
- optional `idempotency_key`: string (prevents double-charging on retries)

**Output (success)**
- `status: "ok"`
- `project_id`
- `anon_key`
- `service_key`
- `api_base` (e.g. `https://api.run402.com`)
- `rest_base`, `auth_base`, `storage_base` (convenience)
- `expires_at` (if you have it)
- also: store keys in the local key store

**Output (needs funds/allowance)**
Return (not throw) a structured object the agent can show to its operator:
- `status: "needs_allowance"`
- `needed_usdc`
- `chain: "base"`
- `reason`
- `docs: "https://run402.com/llms.txt"`
- `funding_link` (create one; even a docs link is fine initially)
- `human_script` (copy/paste)

#### Tool: `run_sql`
**Input**
- `project_id`
- `sql` (string)

**Behavior**
- uses `service_key` from store (or allow override via optional arg)
- calls `POST /admin/v1/projects/:id/sql`

**Output**
- `status: "ok"`
- `rows` (array)
- optional `rowCount`, `fields`, `notice`

#### Tool: `rest_query`
**Input**
- `project_id`
- `method`: `"GET" | "POST" | "PATCH" | "DELETE"`
- `path`: string
  (recommend: require it to start with `/rest/v1/` to prevent foot-guns)
- optional `query`: object (converted to querystring) *or* let agents include `?` in path
- optional `headers`: object
- optional `body`: object | string | null
- optional `as_service`: boolean (default false; use service_key only if true)

**Output**
- `status: "ok"`
- `http_status`
- `json` (if JSON) else `text`
- optional `headers`

#### Tool: `upload_file`
**Input**
- `project_id`
- `bucket`
- `path`
- one of:
  - `content_base64` (best for agents)
  - `text` (convenient)
- optional `content_type`

**Behavior**
- calls `POST /storage/v1/object/:bucket/*` with apikey

**Output**
- `status: "ok"`
- `bucket`, `path`
- optional `etag` / `version`
- optional `signed_url` (if you also call sign endpoint)

#### Tool: `renew_project`
**Input**
- `project_id`
- optional `tier` (default to stored tier or `"prototype"`)

**Output**
- `status: "ok"`
- `project_id`
- `expires_at` (or lease duration)

**Output (needs allowance)**
Same `needs_allowance` shape as provisioning.

### Step 2.4 — Implement payment handling (x402) the agent-friendly way

You want two modes:

#### Mode A: Auto-pay configured (best UX)
- If wallet/provider is configured, your client adds the x402 payment headers and retries automatically.

#### Mode B: No wallet or insufficient funds (still usable)
- Don't hard-fail with a stack trace.
- Return `status:"needs_allowance"` with:
  - exact `needed_usdc` (from `/v1/projects/quote` or from the 402 response payload)
  - "send USDC on Base" instructions
  - link to `run402.com/llms.txt`

**Implementation tip:** even if you don't fully implement x402 client-side yet, you can still:
1) call create/renew
2) if API responds `402`, parse the response and convert it to `needs_allowance`

That gets you shipping quickly while you tighten the payment automation later.

---

## 3) Publishing to OpenClaw registry / ClawHub

Because I don't have the exact ClawHub submission mechanics, here's the pattern that matches most registries:

### What you'll need before submitting
- Public repo: `run402/agent-tools`
- Stable install/run command:
  - `npx @run402/mcp`
  - (optional) Docker: `ghcr.io/run402/mcp:latest`
- Clear README with:
  - what it does (Postgres + REST + auth + storage)
  - tool list
  - env vars
  - payment/allowance behavior
- Manifest file in the format ClawHub expects (copy from an existing skill)
- License (MIT/Apache-2.0)

### Typical submission paths (one of these will be true)
**A) ClawHub has a web submission form**
- Fill in: repo URL, package, install command, env vars, categories/tags
- ClawHub pulls your manifest and validates it

**B) ClawHub is backed by a GitHub "registry" repo**
- You add one entry (JSON/YAML) pointing to your repo + manifest
- Open a PR
- After merge, it appears in ClawHub

### What to optimize for in the listing
- Name: `run402`
- One-line: "Provision a managed Postgres project (REST + Auth + Storage) via x402 USDC on Base"
- Tags: `postgres`, `database`, `storage`, `auth`, `mcp`, `x402`, `usdc`, `base`
- Include the 5 high-level tools only (agents prefer fewer, higher-level tools)

If you can share the URL of the OpenClaw registry repo (or one example PR), I can give you an exact PR diff/template.

---

## 4) Ship as an MCP server (`npx @run402/mcp`)

### Step 4.1 — Implement the MCP server in Node
Use the official SDK:
- dependency: `@modelcontextprotocol/sdk`

Expose the five tools with the schemas above.

Key MCP packaging requirements for `npx`:
- `package.json` includes a `bin` entry
- build outputs into `dist/`
- publish as a public scoped package

Example `packages/mcp/package.json` shape:
```json
{
  "name": "@run402/mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "run402-mcp": "./dist/cli.js"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^<latest>",
    "zod": "^3.0.0"
  }
}
```

Now users can run:
- `npx @run402/mcp` (uses the default bin if you set it up that way)
- or `npx @run402/mcp run402-mcp` depending on how you publish; test this

### Step 4.2 — Document client configs (this drives adoption)
In your MCP README, include copy/paste configs for:
- Claude Desktop
- Cursor
- Cline (VS Code)
- Continue (VS Code)

Even if the exact filenames differ, the common pattern is:
- "command": `npx`
- "args": `["@run402/mcp"]`
- env vars (api base + wallet config)

---

## 5) Where to list/publish the MCP server (max discovery)

High-signal places (as of my knowledge cutoff) that directly drive agent installs:

1) **NPM** (mandatory)
   - `@run402/mcp`
   - add strong `keywords` in `package.json`

2) **GitHub** (mandatory)
   - repo topics: `mcp`, `model-context-protocol`, `postgres`, `database`, `x402`
   - add a `/llms.txt` in the repo too (agents scrape repos)

3) **Official/community MCP directories**
   - **Smithery** (popular MCP registry): https://smithery.ai
     (usually supports "submit server" + install command + env schema)
   - **mcp.so** (community directory): https://mcp.so
   - **Awesome MCP servers list** (PR to GitHub list; commonly used):
     https://github.com/punkpeye/awesome-mcp-servers  *(verify; if different, search "awesome-mcp-servers" and PR the main one)*

4) **Model Context Protocol org repos**
   - If there's a `modelcontextprotocol/servers` or "community servers" list, PR it.
     https://github.com/modelcontextprotocol

5) **Client-specific "MCP server lists"**
   Many clients maintain a docs page or repo section listing known servers (Cursor/Cline/Continue). Search:
   - "Cursor MCP servers"
   - "Cline MCP marketplace"
   - "Continue MCP servers"
   and submit PRs where they accept them.

---

## 6) Concrete "submit everywhere" checklist

### Assets to prepare once
- [ ] Public repo `run402/agent-tools`
- [ ] `@run402/mcp` published on NPM
- [ ] README includes:
  - [ ] tool list + schemas (or links)
  - [ ] `npx @run402/mcp` quickstart
  - [ ] env vars (especially payment/wallet)
  - [ ] "needs_allowance" example output
- [ ] Repo topics set on GitHub
- [ ] Add `llms.txt` in the repo root (mirrors your site docs, condensed)

### OpenClaw / ClawHub
- [ ] Identify required skill manifest format by copying an existing ClawHub skill
- [ ] Add your manifest to repo
- [ ] Submit to ClawHub (web form) **or** PR to OpenClaw registry repo (whichever is their process)
- [ ] After listing, verify the tool names match exactly:
  - `provision_postgres_project`
  - `run_sql`
  - `rest_query`
  - `upload_file`
  - `renew_project`

### MCP registries/directories
- [ ] Submit to Smithery: https://smithery.ai
- [ ] Submit to mcp.so: https://mcp.so
- [ ] PR to Awesome MCP Servers list (likely): https://github.com/punkpeye/awesome-mcp-servers
- [ ] PR to any official/community MCP server list under: https://github.com/modelcontextprotocol

### Package/distribution (optional but high ROI)
- [ ] Publish Docker image: `ghcr.io/run402/mcp`
- [ ] Add a one-liner Docker run example to README
- [ ] Create GitHub Releases (tags) for discoverability
