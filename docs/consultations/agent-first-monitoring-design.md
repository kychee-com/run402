# Consultation Result

**Model**: gpt-5.5-pro
**Submitted**: 2026-04-25T17:30:25.437068
**Completed**: 2026-04-25T17:42:05.708321
**Status**: completed

---

## Opinionated thesis

run402 should not build “Datadog for agents.” It should build an **Ops Inbox with executable fixes**.

For an agent-driven platform, monitoring is not primarily charts, dashboards, or paging. It is:

1. **Detect** important state changes.
2. **Persist** them in a durable project-level ledger.
3. **Summarize** them safely for a future agent with no prior context.
4. **Attach exact evidence and trace links.**
5. **Attach bounded, executable `next_actions[]`.**
6. **Optionally execute pre-authorized safe remediations.**

The killer primitive is:

```ts
await r402.ops.resume({ project, since: "last_seen", markSeen: true })
```

That call should tell any 2026 coding agent: **what changed, what is broken, what already self-healed, what needs attention, and what SDK calls can fix it.**

Everything else — push channels, webhooks, Slack, Telegram, watcher agents — should orbit around that durable source of truth.

---

# 1. Push vs pull vs hybrid

The rule:

> **Pull is truth. Push is wake-up. Watchers are delegated agency.**

### Pull

Use pull when the agent is already active:

```ts
await r402.ops.resume({ project, since: "last_seen" })
await r402.alerts.list({ project, status: "open" })
await r402.apps.health({ project, environment: "production" })
await r402.apps.logs({ project, request_id })
```

Pull should be the default for:

- agent startup / project re-entry
- after deploy
- after reconcile
- after an alert notification
- scheduled Claude/OpenAI/OpenClaw tasks

### Push

Use push only when nobody is actively watching and the issue needs attention before the next likely agent session.

Push-worthy:

- production site down
- DB unavailable
- gateway 5xx spike
- lease entering grace / purge approaching
- quota about to hard-stop app behavior
- custom domain cert failure
- auto-remediation failed

Not push-worthy by default:

- every log exception
- low-confidence anomalies
- preview environment failures
- informational drift
- quota at 50%

Those should land in the Ops Inbox and maybe digest.

### Hybrid

Every signal should flow like this:

```txt
events/logs/health/quota/lease/domain/probes
        ↓
detectors
        ↓
durable alert ledger / ops inbox
        ↓
routes: inbox, email, webhook, watcher, Slack, Telegram, etc.
        ↓
optional watcher / automation / human / future agent
```

Do **not** make Slack/email/webhook the source of truth. They are delivery projections.

Also distinguish:

```ts
r402.alerts.watch(...)      // active stream while agent is running
r402.alerts.subscribe(...)  // durable server-side routing to sinks
r402.ops.resume(...)        // catch-up / state transfer
```

---

# 2. Alert object shape

The alert object should be structured, versioned, stateful, deduped, correlated, and action-oriented.

Important design choice: an alert is not a notification. An alert is the durable state. Notifications are deliveries of alert lifecycle events.

Recommended shape:

```ts
type AlertSeverity = "info" | "warning" | "error" | "critical";

type AlertStatus =
  | "open"
  | "acknowledged"
  | "claimed"
  | "resolving"
  | "snoozed"
  | "resolved";

interface Run402Alert<K extends string = string, D = unknown> {
  object: "alert";
  schema_version: "run402.alert.v1";

  id: `alrt_${string}`;
  revision: number;

  project: string;
  app?: string;
  environment?: string;

  kind: K;
  category:
    | "availability"
    | "runtime"
    | "deploy"
    | "database"
    | "storage"
    | "email"
    | "domain"
    | "quota"
    | "billing"
    | "lifecycle"
    | "drift"
    | "security"
    | "delivery"
    | "custom";

  severity: AlertSeverity;
  status: AlertStatus;

  fingerprint: string;
  title: string;
  summary: string;

  detail: D;

  scope: Array<{
    type:
      | "project"
      | "app"
      | "site"
      | "function"
      | "database"
      | "storage_bucket"
      | "domain"
      | "mailbox"
      | "quota"
      | "lease";
    id?: string;
    name?: string;
    bundle_id?: string;
    app_spec_path?: string;
    owner?: string;
  }>;

  lifecycle: {
    opened_at: string;
    first_observed_at: string;
    last_observed_at: string;
    updated_at: string;
    resolved_at?: string;
    occurrence_count: number;
    flapping?: boolean;
  };

  detector: {
    id: string;
    version: string;
    source:
      | "run402_builtin"
      | "appspec_monitor"
      | "external_probe"
      | "watcher"
      | "third_party"
      | "agent";
    policy_id?: string;
    window?: string;
    threshold?: string;
    confidence?: "low" | "medium" | "high";
  };

  impact?: {
    users_affected_estimate?: number;
    failed_requests?: number;
    total_requests?: number;
    error_rate?: number;
    latency_p95_ms?: number;
    quota_percent?: number;
    projected_exhaust_at?: string;
    cost_at_risk_usd?: number;
  };

  correlation: {
    event_ids?: string[];
    request_ids?: string[];
    trace_ids?: string[];
    deploy_ids?: string[];
    bundle_ids?: string[];
    previous_healthy_bundle_id?: string;
    health_run_ids?: string[];

    log_query?: {
      sdk_call: "r402.apps.logs" | "r402.functions.logs";
      args: Record<string, unknown>;
    };

    diff_query?: {
      sdk_call: "r402.apps.diff";
      args: Record<string, unknown>;
    };
  };

  evidence: Array<{
    type:
      | "metric_window"
      | "health_probe"
      | "log_excerpt"
      | "log_query"
      | "event"
      | "http_probe"
      | "dns_check"
      | "quota_snapshot"
      | "lease_snapshot";

    trust: "platform" | "app_output" | "user_generated" | "third_party";
    tainted?: boolean;
    redacted?: boolean;

    summary?: string;
    data?: unknown;
  }>;

  agent_brief?: {
    text: string;
    generated_by: "run402";
    prompt_safe: boolean;
    contains_untrusted_text: boolean;
  };

  next_actions: AlertNextAction[];

  routing?: {
    muted: boolean;
    subscriptions_matched: string[];
    last_delivery_at?: string;
    delivery_failures?: number;
  };

  ownership?: {
    seen_by?: string[];
    acknowledged_by?: string;
    acknowledged_at?: string;
    claimed_by?: string;
    claim_expires_at?: string;
  };

  resolution?: {
    reason:
      | "condition_cleared"
      | "manual"
      | "auto_remediated"
      | "superseded"
      | "snoozed_expired";
    actor?: string;
    automation_run_id?: string;
    watcher_run_id?: string;
    resolved_by_bundle_id?: string;
  };

  labels?: Record<string, string>;
}
```

`next_actions[]` should reuse the structured-error pattern, but with stronger safety metadata:

```ts
interface AlertNextAction {
  id: string;

  type:
    | "sdk_call"
    | "diagnostic"
    | "docs"
    | "open_url"
    | "approval_request"
    | "watcher_run";

  label: string;
  description?: string;

  sdk_call?: string;
  args?: Record<string, unknown>;

  execution?: {
    via: "agent_calls_sdk" | "r402.alerts.executeAction";
    idempotency_key: string;
  };

  safety: {
    risk: "none" | "low" | "medium" | "high";
    reversible: boolean;
    data_destructive: boolean;
    may_incur_cost_usd?: number;
    requires_approval: boolean;
    grant_id?: string;
  };

  expected_effect?: {
    resolves_alert?: boolean;
    creates_deploy?: boolean;
    changes_tier?: boolean;
    sends_message?: boolean;
  };
}
```

Example function error-rate alert:

```json
{
  "object": "alert",
  "schema_version": "run402.alert.v1",
  "id": "alrt_01hxy...",
  "revision": 4,
  "project": "prj_abc",
  "environment": "production",
  "kind": "run402.function.error_rate",
  "category": "runtime",
  "severity": "error",
  "status": "open",
  "fingerprint": "prod:function:api:5xx_rate",
  "title": "api error rate is 8.4% over 10m",
  "summary": "Production function api started returning elevated 500s shortly after bundle bun_789 was promoted.",
  "scope": [
    {
      "type": "function",
      "name": "api",
      "bundle_id": "bun_789",
      "app_spec_path": "/functions/api"
    }
  ],
  "detector": {
    "id": "builtin.function_error_rate",
    "version": "1",
    "source": "run402_builtin",
    "window": "10m",
    "threshold": "5xx_rate > 5% and requests > 100",
    "confidence": "high"
  },
  "impact": {
    "failed_requests": 104,
    "total_requests": 1240,
    "error_rate": 0.084
  },
  "correlation": {
    "bundle_ids": ["bun_789", "bun_456"],
    "previous_healthy_bundle_id": "bun_456",
    "deploy_ids": ["dep_123"],
    "event_ids": ["evt_deploy_promoted"],
    "log_query": {
      "sdk_call": "r402.apps.logs",
      "args": {
        "project": "prj_abc",
        "environment": "production",
        "function_name": "api",
        "bundleId": "bun_789",
        "since": "2026-04-25T10:10:00Z",
        "filter": "level:error OR status>=500"
      }
    }
  },
  "evidence": [
    {
      "type": "metric_window",
      "trust": "platform",
      "summary": "5xx rate 8.4% across 1240 requests"
    },
    {
      "type": "log_excerpt",
      "trust": "app_output",
      "tainted": true,
      "redacted": true,
      "summary": "TypeError: Cannot read properties of undefined"
    }
  ],
  "agent_brief": {
    "text": "Production api is degraded. The regression correlates with bundle bun_789. Previous bundle bun_456 passed health checks.",
    "generated_by": "run402",
    "prompt_safe": true,
    "contains_untrusted_text": false
  },
  "next_actions": [
    {
      "id": "inspect_logs",
      "type": "diagnostic",
      "label": "Inspect correlated logs",
      "sdk_call": "r402.apps.logs",
      "args": {
        "project": "prj_abc",
        "environment": "production",
        "function_name": "api",
        "bundleId": "bun_789",
        "since": "2026-04-25T10:10:00Z",
        "filter": "level:error OR status>=500"
      },
      "safety": {
        "risk": "none",
        "reversible": true,
        "data_destructive": false,
        "requires_approval": false
      }
    },
    {
      "id": "rollback_previous_healthy",
      "type": "sdk_call",
      "label": "Promote previous healthy bundle",
      "sdk_call": "r402.apps.promote",
      "args": {
        "project": "prj_abc",
        "environment": "production",
        "bundleId": "bun_456"
      },
      "execution": {
        "via": "r402.alerts.executeAction",
        "idempotency_key": "alrt_01hxy.rollback.bun_456"
      },
      "safety": {
        "risk": "low",
        "reversible": true,
        "data_destructive": false,
        "requires_approval": false,
        "grant_id": "grant_safe_prod_rollback"
      },
      "expected_effect": {
        "resolves_alert": true,
        "creates_deploy": true
      }
    }
  ]
}
```

Two especially agent-native details:

1. **Prompt safety.** Log excerpts, inbound email, request bodies, and third-party messages are untrusted. Mark them as tainted. Do not mix raw untrusted text into trusted `agent_brief`.

2. **Action safety.** `next_actions[]` should be exact SDK calls, but server-side execution should still validate that the action was actually generated for that alert and permitted by a grant.

---

# 3. Subscription and policy model

Use both:

1. **Declarative AppSpec / `run402.json` policy** for reproducible app-level monitoring.
2. **Imperative `alerts.subscribe()`** for quick setup, personal contacts, generated webhooks, and secrets.

The declarative policy should be canonical for monitors, routes, and automations. The imperative API should be ergonomic sugar that writes the same policy objects.

## AppSpec shape

Example:

```json
{
  "ops": {
    "version": 1,

    "defaults": [
      "lease",
      "quota",
      "domain",
      "function_errors",
      "gateway_errors",
      "deploy_regressions",
      "scheduled_function_misses"
    ],

    "monitors": [
      {
        "id": "homepage",
        "type": "http",
        "url": "${site.url}/",
        "external": true,
        "interval": "60s",
        "regions": ["iad", "fra"],
        "assert": {
          "status": [200, 399],
          "max_latency_ms": 3000
        },
        "alert": {
          "after_failures": 3,
          "severity": "critical"
        }
      },
      {
        "id": "verify-probes",
        "type": "verify",
        "probes": "all",
        "interval": "5m",
        "external": true,
        "alert": {
          "severity": "error"
        }
      },
      {
        "id": "api-error-rate",
        "type": "metric",
        "signal": "gateway.5xx_rate",
        "where": {
          "function": "api",
          "environment": "production"
        },
        "window": "10m",
        "condition": {
          "gt": 0.05,
          "min_count": 100
        },
        "alert": {
          "severity": "error"
        }
      }
    ],

    "routes": [
      {
        "id": "prod-critical",
        "match": {
          "environment": "production",
          "severity": ["error", "critical"]
        },
        "to": ["inbox", "contact:agent", "sink:agent-webhook"],
        "events": ["alert.opened", "alert.escalated", "alert.resolved"],
        "repeat": "30m"
      },
      {
        "id": "cost-and-lease-digest",
        "match": {
          "category": ["quota", "billing", "lifecycle"],
          "severity": ["warning"]
        },
        "to": ["inbox", "contact:agent"],
        "batch": "6h"
      }
    ],

    "automations": [
      {
        "id": "renew-small-lease",
        "match": {
          "kind": "run402.lease.expiring",
          "severity": ["warning", "error"]
        },
        "action": "next_action:renew_current_tier",
        "grant": "grant:lease-renewal-under-20-usd",
        "notify_after": ["inbox", "contact:agent"]
      }
    ]
  }
}
```

Important: secrets should not have to live in `run402.json`. The policy can reference sink IDs. The sink target URL/token can be created imperatively.

## Imperative subscription API

Good ergonomic form:

```ts
await r402.alerts.subscribe({
  project,
  id: "prod-critical-to-agent",
  upsert: true,

  match: {
    environment: "production",
    severity: ["error", "critical"]
  },

  events: ["alert.opened", "alert.escalated", "alert.resolved"],

  to: [
    { type: "inbox" },
    { type: "contact", contact: "agent" },
    {
      type: "webhook",
      id: "agent-webhook",
      url: process.env.AGENT_ALERT_WEBHOOK!,
      signing: "hmac-sha256",
      payload: "compact"
    }
  ],

  delivery: {
    repeat: "30m",
    max_per_hour: 10
  }
});
```

Lower-level normalized APIs:

```ts
await r402.alerts.sinks.create({
  project,
  id: "agent-webhook",
  type: "webhook",
  url: "https://agent.example.com/run402-alerts",
  signing: { algorithm: "hmac-sha256" },
  retry: {
    max_attempts: 12,
    max_age: "24h"
  }
});

await r402.alerts.sinks.test({
  project,
  sinkId: "agent-webhook"
});

await r402.alerts.policy.reconcile({
  project,
  source: "appspec",
  policy: appSpec.ops,
  dryRun: false
});
```

Webhook delivery should be signed and idempotent:

```http
POST /run402-alerts
Run402-Event-Id: evt_123
Run402-Event-Type: alert.opened
Run402-Delivery-Id: dlv_456
Run402-Timestamp: 2026-04-25T10:22:00Z
Run402-Signature: v1=...
```

Payload:

```json
{
  "schema_version": "run402.alert_delivery.v1",
  "event_id": "evt_123",
  "event_type": "alert.opened",
  "created_at": "2026-04-25T10:22:00Z",
  "project": "prj_abc",
  "subscription_id": "sub_prod_critical",
  "alert": {
    "id": "alrt_01hxy...",
    "kind": "run402.function.error_rate",
    "severity": "error",
    "status": "open",
    "title": "api error rate is 8.4% over 10m",
    "summary": "Production function api started returning elevated 500s shortly after bundle bun_789 was promoted.",
    "next_actions": [
      {
        "id": "inspect_logs",
        "label": "Inspect correlated logs",
        "sdk_call": "r402.apps.logs"
      },
      {
        "id": "rollback_previous_healthy",
        "label": "Promote previous healthy bundle",
        "sdk_call": "r402.apps.promote"
      }
    ]
  },
  "recommended_pull": {
    "sdk_call": "r402.ops.resume",
    "args": {
      "project": "prj_abc",
      "since": "evt_123"
    }
  }
}
```

The push payload should usually be compact. The receiving agent should pull full context with auth.

---

# 4. Channels: day-one vs later

Do not make channel sprawl the product. The product is the Ops Inbox and executable actions.

### Day one

| Channel | Why |
|---|---|
| `inbox` / alert ledger | Mandatory source of truth. |
| Email to `agent.contact` | Already mostly exists via `email.send` notification template. Good fallback. |
| Signed webhook | Universal agent wake-up primitive. Works with OpenClaw, custom agents, Slack incoming webhook, etc. |
| Internal function sink | Invoke a run402 function directly as a watcher/handler without requiring a public URL. |
| Active stream / watch | Useful while CLI/MCP/SDK session is alive. |

I would generalize the existing mailbox webhook infrastructure into a project-wide webhook delivery system rather than creating separate webhook systems per namespace.

### Soon after

| Channel | Why |
|---|---|
| Telegram | Simple, useful for solo builders and OpenClaw-style workflows. |
| Slack | Important for teams, but OAuth/installation complexity makes it less important than generic webhooks initially. |
| GitHub issue / PR comment | Very agent-native. Durable, code-adjacent, and visible to future coding sessions. |
| Linear/Jira | Team workflow, later. |

### Later / paid

| Channel | Why |
|---|---|
| SMS / WhatsApp | Human escalation, paid pass-through. |
| PagerDuty / Opsgenie | Enterprise compatibility, not core agent-first DX. |
| Third-party monitoring ingest | Accept Better Stack/Pingdom/etc. as signal sources, normalized into run402 alerts. |

---

# 5. Watcher pattern

Yes, ship a `Watcher` primitive.

But it should not be required for basic monitoring. Server-side detectors should handle leases, quotas, domains, certs, gateway errors, function crashes, deploy regressions, and uptime checks.

A Watcher is for semantic decisions:

- inspect logs
- compare current bundle to previous bundle
- decide whether rollback is safe
- open a PR
- notify a human with a diagnosis
- execute pre-authorized low-risk actions
- escalate if uncertain

Public API:

```ts
await r402.watchers.create({
  project,
  name: "prod-ops-agent",

  schedule: "*/15 * * * *",

  triggers: [
    {
      type: "alert",
      match: {
        environment: "production",
        severity: ["error", "critical"]
      }
    }
  ],

  handler: {
    type: "function",
    sourceDir: "./ops-watcher",
    export: "default"
  },

  inputs: {
    resume: true,
    openAlerts: true,
    recentEvents: "2h",
    logsWindow: "30m"
  },

  permissions: {
    read: [
      "ops.resume",
      "alerts.read",
      "apps.describe",
      "apps.events",
      "apps.logs",
      "apps.health"
    ],

    actions: [
      {
        sdk_call: "r402.alerts.ack"
      },
      {
        sdk_call: "r402.alerts.executeAction",
        constraints: {
          max_risk: "low"
        }
      },
      {
        sdk_call: "r402.apps.promote",
        constraints: {
          environment: "production",
          only_previous_healthy_bundle: true
        }
      }
    ],

    budget: {
      max_usd_per_run: 0.25,
      max_usd_per_month: 10
    }
  },

  escalation: {
    ifUnhandledFor: "30m",
    to: ["contact:agent"]
  }
});
```

Watcher handler shape:

```ts
import { defineWatcher } from "@run402/sdk/watchers";

export default defineWatcher(async (ctx) => {
  const resume = await ctx.ops.resume({
    project: ctx.project,
    since: "last_seen",
    markSeen: true,
    maxContextBytes: 8000
  });

  for (const alert of resume.alerts.open) {
    await ctx.alerts.claim({
      alertId: alert.id,
      ttl: "10m"
    });

    const safeRollback = alert.next_actions.find(
      (a) =>
        a.id === "rollback_previous_healthy" &&
        a.safety.risk === "low" &&
        !a.safety.requires_approval
    );

    if (safeRollback) {
      await ctx.alerts.executeAction({
        alertId: alert.id,
        actionId: safeRollback.id
      });

      continue;
    }

    await ctx.message.send({
      to: "agent.contact",
      body: `run402 needs attention: ${alert.title}\n\n${alert.summary}`
    });
  }
});
```

Implementation-wise, v1 can be sugar over:

- scheduled functions
- alert subscriptions
- scoped API tokens
- stored watcher cursors
- watcher run logs

But product-wise, it deserves its own resource because it adds:

- state cursor
- least-privilege permissions
- action grants
- audit trail
- trigger semantics
- escalation behavior
- concurrency control via alert claim/lease

Also: built-in monitors should **not** consume a user’s scheduled-function quota. Do not force Prototype users to burn their one scheduled function just to know their app is down.

---

# 6. External black-box monitoring

run402 should host basic black-box monitoring directly.

Not a full Pingdom clone. But enough to confidently say:

- public site is unreachable
- TLS cert is invalid/expiring
- DNS is wrong
- custom domain does not resolve to run402
- gateway returns elevated 5xx
- health endpoint fails from outside run402’s serving path

This should integrate with the proposed `apps.health` and AppSpec `verify` block.

Recommended model:

```ts
await r402.monitors.create({
  project,
  id: "homepage",
  type: "http",
  environment: "production",
  url: "https://example.com/",
  external: true,
  regions: ["iad", "fra", "sin"],
  interval: "60s",
  timeout: "5s",
  assert: {
    status: [200, 399],
    bodyIncludes: "ok"
  },
  alert: {
    after_failures: 3,
    quorum: 2,
    severity: "critical"
  }
});
```

Better: most agents should not need to call that directly. If the AppSpec has:

```json
{
  "verify": {
    "probes": [
      {
        "id": "homepage",
        "type": "http",
        "path": "/",
        "expect": {
          "status": 200
        }
      }
    ]
  },
  "ops": {
    "monitors": [
      {
        "type": "verify",
        "probes": "all",
        "external": true,
        "interval": "5m"
      }
    ]
  }
}
```

then run402 should run those probes continuously.

Third-party integration is still useful, but as ingest:

```ts
await r402.alerts.ingestSources.create({
  project,
  id: "betterstack",
  type: "webhook",
  normalizeAs: "external_monitor"
});
```

But first-party black-box checks are table stakes if the promise is “run402 monitors itself.”

---

# 7. Auto-remediation envelope

Yes, allow pre-registered handlers.

But use explicit, bounded **Action Grants**. Never let an arbitrary alert payload trigger arbitrary SDK calls.

Risk ladder:

| Class | Examples | Default |
|---|---|---|
| Diagnostic | fetch logs, run health, describe diff | auto allowed |
| Low-risk reversible | restart function, promote previous healthy bundle | pre-authorizable |
| Cost-incurring bounded | renew lease up to $X, top up quota | pre-authorizable with budget |
| Risky mutable | DB migration, destructive prune, domain changes | approval required |
| Code generation/deploy | patch app and deploy | watcher/agent may prepare PR; prod deploy needs policy/grant |

Grant example:

```ts
await r402.automations.grants.create({
  project,
  id: "lease-renewal-under-20-usd",
  description: "Allow run402 to renew the current tier if the project lease is near expiry.",

  allow: [
    {
      sdk_call: "r402.tier.set",
      constraints: {
        same_or_lower_tier: true,
        max_cost_usd: 20
      }
    }
  ],

  budget: {
    max_usd_per_action: 20,
    max_usd_per_month: 20
  },

  expires_at: "2026-12-31T00:00:00Z",
  notify_after: ["inbox", "contact:agent"]
});
```

Automation example:

```ts
await r402.automations.create({
  project,
  id: "auto-renew-lease",

  trigger: {
    alert: {
      kind: "run402.lease.expiring",
      severity: ["warning", "error"]
    }
  },

  action: {
    from_next_action: "renew_current_tier"
  },

  grant: "lease-renewal-under-20-usd",

  guards: {
    max_runs_per_period: {
      count: 1,
      period: "30d"
    }
  },

  audit: true
});
```

Rollback automation example:

```ts
await r402.automations.create({
  project,
  id: "rollback-bad-prod-bundle",

  trigger: {
    alert: {
      kind: "run402.function.error_rate",
      environment: "production",
      severity: ["error", "critical"]
    }
  },

  action: {
    from_next_action: "rollback_previous_healthy"
  },

  guards: {
    only_if_previous_bundle_passed_health: true,
    only_if_no_destructive_migration_between_bundles: true,
    max_runs_per_period: {
      count: 2,
      period: "1h"
    },
    run_health_after: true
  },

  approval: {
    mode: "preauthorized",
    max_risk: "low"
  },

  notify_after: ["inbox", "contact:agent"]
});
```

Every automation should create an immutable audit record:

```ts
await r402.automations.runs.list({
  project,
  alertId: "alrt_01hxy..."
});
```

Run record:

```json
{
  "id": "arun_123",
  "project": "prj_abc",
  "trigger_alert_id": "alrt_01hxy...",
  "action_id": "rollback_previous_healthy",
  "grant_id": "grant_safe_prod_rollback",
  "status": "succeeded",
  "started_at": "2026-04-25T10:24:00Z",
  "completed_at": "2026-04-25T10:24:18Z",
  "actor": "automation:rollback-bad-prod-bundle",
  "sdk_calls": [
    {
      "sdk_call": "r402.apps.promote",
      "args": {
        "environment": "production",
        "bundleId": "bun_456"
      },
      "status": "succeeded"
    }
  ],
  "cost_usd": 0,
  "result": {
    "new_bundle_id": "bun_456",
    "health_after": "passing"
  }
}
```

Autonomy is too much when:

- the action can destroy user data
- the action can spend unbounded money
- the action performs irreversible infra mutation
- the action deploys newly generated code directly to production without an explicit grant
- the action is derived from untrusted logs/request content

---

# 8. The catch-up call

Yes: the first call any agent makes after re-entering a project should be one catch-up call.

I would not make it just:

```ts
r402.alerts.list({ project, since: "last_seen", status: "open" })
```

That is useful but insufficient. The agent also needs resolved incidents, auto-remediations, deploys, health, cost, drift, and delivery failures.

Make the primary call:

```ts
const resume = await r402.ops.resume({
  project,
  actor: "agent:claude-code",
  since: "last_seen",
  environment: "production",
  markSeen: true,
  maxContextBytes: 12000,

  include: [
    "open_alerts",
    "resolved_since",
    "deploys",
    "health",
    "quota",
    "lease",
    "domain",
    "drift",
    "automations",
    "watcher_runs",
    "delivery_failures",
    "recommended_next_actions"
  ]
});
```

Response:

```ts
interface OpsResume {
  schema_version: "run402.ops.resume.v1";

  project: string;
  actor: string;
  generated_at: string;

  previous_cursor?: string;
  cursor: string;

  overall_state:
    | "healthy"
    | "degraded"
    | "down"
    | "at_risk"
    | "unknown";

  attention_required: boolean;

  brief: {
    text: string;
    prompt_safe: true;
    max_context_bytes: number;
  };

  alerts: {
    open: Run402Alert[];
    resolved_since: Run402Alert[];
    snoozed_count: number;
  };

  health: {
    state: "passing" | "failing" | "unknown";
    failing_monitors: number;
    last_run_id?: string;
  };

  lifecycle: {
    lease_state?: "active" | "grace" | "dormant" | "purged";
    next_transition_at?: string;
    scheduled_purge_at?: string;
  };

  quota: Array<{
    metric: string;
    used: number;
    limit: number;
    percent: number;
    projected_exhaust_at?: string;
  }>;

  changes: {
    deploys: unknown[];
    domain_changes: unknown[];
    drift: unknown[];
  };

  remediations: {
    automation_runs: unknown[];
    watcher_runs: unknown[];
  };

  recommended_next_actions: AlertNextAction[];
}
```

Example brief:

```json
{
  "overall_state": "degraded",
  "attention_required": true,
  "brief": {
    "text": "Since your last session, production bundle bun_789 caused elevated 500s in function api. run402 auto-promoted previous healthy bundle bun_456 using grant grant_safe_prod_rollback, and the alert resolved 4 minutes later. One warning remains: email quota is at 86% and projected to exhaust in 2 days.",
    "prompt_safe": true,
    "max_context_bytes": 12000
  }
}
```

Important semantics:

- `since: "last_seen"` should return **all open alerts**, even if opened before the cursor.
- `markSeen` should not acknowledge. Seen means “included in this resume.” Ack means “an actor accepted responsibility.”
- Cursors should be per actor/API key/contact, but agents should also be able to pass explicit cursors.
- The response should be compact by default and expand evidence lazily.

---

# 9. How this plugs into Claude/OpenAI scheduled tasks

Do both:

1. run402 runs its own server-side monitors
2. external scheduled agents can poll `ops.resume`

Do not rely on Claude/OpenAI scheduled tasks for core detection. They are execution brains, not platform monitors.

The stable target for all scheduled agents is:

```ts
r402.ops.resume({ project, since: "last_seen" })
```

Provider-task helper:

```ts
const task = await r402.agents.scheduledTaskSpec({
  provider: "claude_tasks",
  project,
  schedule: "*/30 * * * *",

  instructions: `
    Call r402.ops.resume.
    If critical alerts are open, inspect next_actions.
    Execute only actions with risk none or low.
    If uncertain, send a message to agent.contact.
  `,

  token: {
    scopes: [
      "ops:read",
      "alerts:read",
      "alerts:write",
      "actions:execute:low"
    ],
    expires_in: "90d"
  }
});
```

For OpenClaw/push-style agents:

```ts
await r402.alerts.subscribe({
  project,
  id: "critical-to-openclaw",
  match: {
    severity: ["error", "critical"],
    environment: "production"
  },
  to: [
    {
      type: "webhook",
      url: process.env.OPENCLAW_TRIGGER_URL!,
      signing: "hmac-sha256",
      payload: "compact"
    }
  ]
});
```

For Anthropic Agent SDK-style state/memory/MCP hooks, expose:

- MCP tool: `run402_ops_resume`
- MCP tool: `run402_alerts_execute_action`
- MCP resource: `run402://projects/{project}/ops`
- prompt: “Resume run402 project operations”

The agent SDK hook should call `ops.resume` on project open and store the returned cursor.

---

# 10. Existing primitive mapping

Build on what already exists:

### `email.*`

Use `email.send` with the existing `notification` template for email sinks.

Email payload should be short:

```txt
[run402:error] api error rate is 8.4% over 10m

Project: prj_abc
Alert: alrt_01hxy
Next: call r402.ops.resume({ project: "prj_abc" })
```

Do not stuff logs into email.

### Mailbox webhooks

Generalize this delivery infrastructure into `alerts.sinks.webhook`.

Mailbox webhooks are currently “push on inbound email.” Alerts need the same delivery semantics:

- target URL
- signing secret
- retries
- dead-letter state
- test event
- delivery listing

### Scheduled functions

Use them as the first implementation backend for Watchers, but do not make built-in monitoring depend on user cron quotas.

### `agent.contact`

Treat this as the default sink:

```ts
{ type: "contact", contact: "agent" }
```

Long-term, evolve it into a general contacts registry, but keep compatibility.

### `message.send`

Use as a low-level sink implementation, not the alert API.

### `functions.logs`

Keep as legacy/function-level diagnostic action. Prefer proposed `apps.logs` for correlated, bundle-scoped queries.

### Proposed `apps.events`, `apps.logs`, `apps.health`

These become the signal and evidence backbone:

- `apps.events` includes alert lifecycle events
- `apps.logs` powers alert evidence and `inspect_logs` actions
- `apps.health` runs verify probes on demand and on schedule
- `apps.diff` / `apps.describe` become drift alert next actions
- `apps.promote` becomes rollback remediation

---

# 11. Cost model

Monitoring should feel included.

Recommended pricing posture:

| Feature | Pricing |
|---|---|
| Alert ledger / Ops Inbox | included |
| Lease/quota/domain/cert/lifecycle alerts | included |
| Function crash/error/gateway detectors | included |
| Email/webhook delivery | included with sane rate limits |
| Basic external uptime checks | included, tiered by interval/regions |
| Alert retention | tiered |
| Log retention | tiered separately |
| Watchers | billed like scheduled/serverless compute, with one small included watcher on paid tiers |
| SMS/WhatsApp | pass-through |
| LLM-powered diagnosis | bring-your-own-model or explicitly metered |
| Third-party destinations | free unless provider costs money |

Do not charge per alert. That creates bad incentives.

Also: built-in external checks should be separate from scheduled-function limits. A Prototype project with one scheduled function should still get basic uptime monitoring.

---

# 12. Concrete agent iteration loop

Initial deploy:

```ts
await r402.admin.setAgentContact({
  project,
  email: "owner@example.com"
});

await r402.apps.reconcileDir({
  project,
  dir: "."
});

// Creates durable routes.
await r402.alerts.subscribe({
  project,
  id: "prod-critical",
  upsert: true,
  match: {
    environment: "production",
    severity: ["error", "critical"]
  },
  to: [
    { type: "inbox" },
    { type: "contact", contact: "agent" },
    {
      type: "webhook",
      url: process.env.AGENT_WAKE_WEBHOOK!,
      signing: "hmac-sha256"
    }
  ]
});

// Optional.
await r402.watchers.create({
  project,
  name: "prod-ops-agent",
  schedule: "*/15 * * * *",
  triggers: [
    {
      type: "alert",
      match: { severity: ["error", "critical"] }
    }
  ],
  handler: {
    type: "function",
    sourceDir: "./ops-watcher"
  },
  permissions: {
    read: ["ops.resume", "alerts.read", "apps.logs", "apps.health"],
    actions: [
      {
        sdk_call: "r402.alerts.executeAction",
        constraints: { max_risk: "low" }
      }
    ]
  }
});
```

Later, production breaks:

1. run402 detects elevated 500s.
2. It creates `alrt_...` with fingerprint `prod:function:api:5xx_rate`.
3. It correlates to bundle `bun_789`.
4. It attaches logs query, health run, previous healthy bundle.
5. It pushes compact notification to webhook/email.
6. Watcher claims the alert.
7. Watcher executes `rollback_previous_healthy` because a grant allows it.
8. run402 records automation/watcher run.
9. Alert resolves when health passes.
10. Future agent calls `ops.resume` and sees exactly what happened.

Future agent re-enters:

```ts
const resume = await r402.ops.resume({
  project,
  since: "last_seen",
  markSeen: true
});

if (resume.attention_required) {
  for (const action of resume.recommended_next_actions) {
    if (!action.safety.requires_approval && action.safety.risk === "none") {
      // safe diagnostic action
    }
  }
}
```

This is the core DX.

---

# 13. What to ship first

If I were sequencing this:

### v1: Ops Inbox foundation

- `alerts` object model
- default built-in detectors:
  - lease expiring / grace / dormant / purge
  - quota thresholds and burn-rate
  - function crash loop
  - gateway 5xx rate
  - domain DNS/cert issues
  - scheduled function missed/paused
  - deploy health regression
- `alerts.list/get/ack/snooze/resolve`
- `ops.resume`
- email sink via existing notification template
- signed webhook sink
- alert lifecycle events in `apps.events`
- `next_actions[]` on alerts

### v2: Policies and black-box checks

- AppSpec `ops` block
- `alerts.subscribe`
- `alerts.policy.reconcile`
- external HTTP/TLS/DNS probes
- verify probes as scheduled monitors
- sink delivery logs/test/retry

### v3: Watchers and action grants

- `watchers.create`
- scoped watcher token
- alert claim/lease
- `alerts.executeAction`
- automation grants
- automation audit trail

### v4: Native integrations

- Telegram
- Slack
- GitHub issues/PR comments
- Claude/OpenAI scheduled-task helper specs
- third-party alert ingest

---

# 14. The single winning feature

The winning primitive is:

```ts
r402.ops.resume()
```

backed by:

- default monitoring
- durable alert ledger
- LLM-safe agent brief
- trace/log/health correlation
- executable `next_actions[]`
- bounded action grants
- audit trail

Call the product concept **Agent Ops Inbox** or **run402 Watchtower**.

The promise to Cursor, Claude Code, Devin, OpenClaw, Codex:

> “If you deploy on run402, every project has a self-maintaining ops memory. When your agent comes back tomorrow, it can ask one question — `ops.resume` — and get the exact state of the app, what broke, what self-healed, what remains risky, and which SDK calls are safe to run next.”

That is what AWS + CloudWatch + PagerDuty + Datadog do not provide for agents. They emit data. run402 should emit **operational state plus safe agency**.

---
**Wall time**: 11m 40s
**Tokens**: 3,138 input, 36,532 output (26,994 reasoning), 39,670 total
**Estimated cost**: $6.6699
