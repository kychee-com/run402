# Endpoint tools fixture

Three Astro endpoint files that declare MCP tools beside their handlers. `astro/src/endpoint-tools.test.ts` reads them the way the adapter does at `astro build`: from source, by parsing, never by running them. `astro/src/preset.test.ts` builds a copy of the site without `feed.json.ts` through `run402({ base: "/app" })`, and checks that every tool path starts with `/app`.

| File | Route | What it shows |
|---|---|---|
| `src/pages/api/notes.ts` | `/api/notes` | A static path with `GET` and `POST`: `tools` declares one tool for each, and each states its `method`. |
| `src/pages/api/notes/[note_id].ts` | `/api/notes/[note_id]` | A dynamic path with one handler: `tool` states its `name`, takes `POST` from the file, and is bound to `/api/notes/{note_id}`. |
| `src/pages/feed.json.ts` | `/feed.json` | A prerendered endpoint. A static file answers its path, so its tool fails the build with `MCP_TOOL_ROUTE_ELSEWHERE`. |

Built as it stands, the site fails on `feed.json.ts`, which is the point of that file. Without it, `dist/run402/adapter.json` lists `list_notes`, `add_note` and `update_note` under `tools`.
