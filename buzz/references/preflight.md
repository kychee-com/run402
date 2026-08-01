# Buzz setup preflight

This preflight is the first executable setup stage. Run it through the managed agent's existing command-execution boundary. The human stays in Buzz chat; do not turn these implementation steps into human terminal instructions.

## Outer bootstrap

Before invoking any Run402 or Buzz mutation:

1. Resolve the intended agent's public `npub` or 64-character hex subject only from Buzz-supplied public context.
2. Choose the one unique dedicated Run402 profile label that will be passed explicitly as `--wallet <profile>`.
3. Verify that the managed session exposes a configured shell and can execute a bounded no-op. If the agent has no command-execution boundary, return the static `BUZZ_PREFLIGHT_SHELL_UNAVAILABLE` block below.
4. Invoke the session's actual Node executable as an argument array with `--version`. Node must be 22 or newer. Do not use an ambient shell alias as evidence when the exact executable cannot be spawned.
5. If Node passes, invoke `npm --version` and `run402 --version` as argument arrays. If Run402 is absent but npm works, the user's setup request authorizes the safe user-global action `npm install -g run402@latest`; execute it once and restart the complete preflight. If npm or the helper runtime is unavailable, return the matching static block and stop.
6. Invoke the canonical read-only diagnostic:

   ```sh
   run402 --wallet <profile> doctor --buzz --buzz-agent <public-agent-npub-or-hex>
   ```

7. Branch only on the raw JSON `checks[].name`, `status`, `code`, and `next_actions[].type`. A completed report exits 0 when only `ok`/`warning` checks exist and exits 1 when any check is `blocked`. A usage error appears on stderr instead of stdout.

Do not inspect `BUZZ_PRIVATE_KEY`, an `nsec`, wallet secret, or another secret-bearing environment value while bootstrapping. Installation and bootstrap must leave `mutation_state: "not_started"`.

## Static outer failures

Use the exact report shape below only when Run402 cannot execute and therefore could not have produced `doctor --buzz` output. Include one action and never claim the doctor ran.

Missing or unusable command execution:

```json
{
  "ok": false,
  "mode": "buzz_bootstrap",
  "contract_id": "run402.buzz-doctor.v1",
  "mutation_state": "not_started",
  "checks": [{
    "name": "session_shell",
    "status": "blocked",
    "code": "BUZZ_PREFLIGHT_SHELL_UNAVAILABLE",
    "next_actions": [{
      "type": "repair_buzz_agent_runtime",
      "surface": "buzz_settings",
      "command": "Open Buzz Desktop > Settings > Agents, select this agent, choose a runtime with command execution enabled, restart the agent, then rerun Run402 setup.",
      "why": "Run402 setup needs the managed agent's configured shell before it can diagnose or mutate anything.",
      "safe_to_auto_execute": false,
      "requires_approval": true,
      "destructive": false,
      "idempotent": true,
      "spend_impact": { "currency": "USD", "max_amount": "0" }
    }]
  }]
}
```

Missing Node uses the same shape with check `node_runtime`, code `BUZZ_PREFLIGHT_NODE_UNAVAILABLE`, and this one action:

```json
{
  "type": "repair_buzz_node_runtime",
  "surface": "buzz_settings",
  "command": "Open Buzz Desktop > Settings > Updates, install the available Buzz update, restart this agent, then rerun Run402 setup.",
  "why": "The managed session must provide a spawnable Node 22+ runtime.",
  "safe_to_auto_execute": false,
  "requires_approval": true,
  "destructive": false,
  "idempotent": true,
  "spend_impact": { "currency": "USD", "max_amount": "0" }
}
```

Use `BUZZ_PREFLIGHT_NODE_INCOMPATIBLE` instead when the exact executable reports a major below 22.

Missing Run402 after Node/npm pass uses check `run402_cli`, code `BUZZ_PREFLIGHT_RUN402_UNAVAILABLE`, and the shell action below. The agent may auto-execute it because the setup request already authorized the one necessary user-global CLI install; the human is not asked to paste it.

```json
{
  "type": "install_run402_cli",
  "surface": "shell",
  "command": "npm install -g run402@latest",
  "argv": ["npm", "install", "-g", "run402@latest"],
  "why": "Install Run402 in the user-global npm context used by the Buzz setup helper.",
  "safe_to_auto_execute": true,
  "requires_approval": false,
  "destructive": false,
  "idempotent": true,
  "spend_impact": { "currency": "USD", "max_amount": "0" }
}
```

If npm itself is unavailable, use `BUZZ_PREFLIGHT_RUN402_UNAVAILABLE` with `surface: "buzz_settings"` and this complete repair command: `Open Buzz Desktop > Settings > Updates, install the available Buzz update, restart this agent, then rerun Run402 setup.` Do not invent a Homebrew, Cargo, curl, or public Buzz-sidecar installer.

## Doctor result handling

The doctor always returns this ordered set: `session_shell`, `node_runtime`, `run402_cli`, `buzz_cli`, `buzz_agent_target`, `run402_api`, `run402_console`, `buzz_relay`, `wallet_profile`. Report every independent block in the same Buzz response. Each actionable check already carries exactly one complete `shell`, `buzz_chat`, or `buzz_settings` repair. Auto-execute only when `safe_to_auto_execute: true`, then rerun the entire bootstrap and doctor.

Relay safety and relay availability are separate. `BUZZ_PREFLIGHT_RELAY_UNSAFE` is blocking and setup must not connect to the destination. `BUZZ_PREFLIGHT_RELAY_UNREACHABLE` is a warning after the relay URL has been safely contained: founder-agent setup and the org-of-one path may continue, but community-installation discovery and agent enrollment remain unavailable until a later live relay read succeeds. Preserve the warning and its exact action in the receipt. For `failure: "tls_handshake_failed"`, tell the Buzz community operator to repair the named public hostname/certificate route; do not tell the human to reconnect the same broken URL.

A passing doctor proves only that the managed execution boundary is ready. It does not prove a Run402 principal exists, an identity link is active, a project was created, a demo was deployed, or a human adopted the organization.
