## Context

The `get_function_logs` endpoint returns the last N log entries from CloudWatch. There is no way to request only logs newer than a known timestamp, forcing clients to re-fetch and manually deduplicate. The CLI has no continuous tailing mode for active debugging.

CloudWatch's `FilterLogEventsCommand` already supports a `startTime` parameter (epoch ms, inclusive). The gateway currently doesn't expose it.

## Goals / Non-Goals

**Goals:**
- Add `since` query parameter to the logs API endpoint
- Add `since` parameter to the MCP tool
- Add `--since` and `--follow` flags to the CLI
- Zero duplicates and zero lost logs during follow mode

**Non-Goals:**
- Server-side streaming (SSE/WebSocket) — polling is sufficient for this use case
- Configurable poll interval via CLI flag — hardcode 3s, revisit if users ask
- Log filtering by level/pattern — separate feature

## Decisions

### 1. `since` as epoch milliseconds in the API

The API accepts `since` as an integer (epoch ms). This maps 1:1 to CloudWatch's `startTime` with no parsing or timezone ambiguity. The MCP tool accepts an ISO timestamp string and converts to epoch ms before calling the API.

**Alternative considered:** ISO string at the API level. Rejected because it adds parsing complexity on the server for no benefit — CloudWatch wants epoch ms anyway.

### 2. Client-side `+1ms` to avoid duplicates

CloudWatch's `startTime` is inclusive (`>=`). To avoid re-fetching the last-seen log entry, the CLI and MCP pass `lastSeenTimestamp + 1ms` as the `since` value. This is the client's responsibility, not the server's — the API parameter is a clean passthrough.

**Alternative considered:** Making the API exclusive (`>`). Rejected because it diverges from CloudWatch semantics and would confuse anyone reading the gateway code.

### 3. CLI `--follow` as a polling loop with fixed 3s interval

The CLI polls every 3 seconds, prints new log lines, and updates the `since` cursor. 3 seconds balances responsiveness against API call volume (~20 calls/min). The loop runs until Ctrl-C.

**Alternative considered:** Configurable `--interval` flag. Deferred — 3s is fine for now, and adding it later is backwards-compatible.

### 4. MCP tool gets `since` but not follow

The MCP tool adds an optional `since` parameter (ISO string). LLMs naturally "follow" by calling the tool repeatedly during debugging. No loop needed.

### 5. Follow mode output format

Follow mode prints each new log line as `[timestamp] message` — same format as the non-follow output but streamed line by line. No JSON wrapper in follow mode.

## Risks / Trade-offs

- **[Risk] CloudWatch eventually-consistent reads** → Logs may appear with a few seconds delay after invocation. The 3s poll interval masks this in practice. Not a problem for debugging workflows.
- **[Risk] Long-running follow sessions accumulate API calls** → Acceptable for debugging. If quota becomes a concern, could add a max-duration or warn after N minutes. Deferred.
- **[Trade-off] Fixed 3s interval** → Simple but not configurable. Easy to add `--interval` later if needed.
