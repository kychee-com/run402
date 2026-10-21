---
title: Push notifications
description: Sign a signed-in user's phone up from the app's page, send from a function, and check delivery from the CLI.
---

A Run402 app can put a notification on its users' phones. The notification itself is a web standard (the Push API and a service worker): the phone's browser shows it, even when the app is closed. What Run402 adds is the server side: it keeps each phone's subscription against the signed-in user, encrypts every message for each phone, delivers it to the phone's push service, and drops subscriptions the push service says are gone. **The server decides when to notify, never the phone.** Something on your side has to notice a condition and call `push.send`, usually a scheduled function.

```bash
run402 push status --project prj_example
run402 push status --message pmsg_123 --project prj_example
```

Use the [push command reference](/cli/functions/) for the output fields and the [SDK namespace](/sdk/resources/) for the typed reads (`r.push.status`, `r.push.getMessage`). Push needs Run402 Cloud: on self-hosted Run402 Core, `push.send` throws `PUSH_UNSUPPORTED`.

## Sign a phone up (the browser side)

Every app host serves the browser helper at `/_run402/push.js`, which defines `window.Run402Push`:

```html
<script src="/_run402/push.js"></script>
<button id="notify">Notify me</button>
<script>
  document.getElementById("notify").addEventListener("click", async () => {
    await Run402Push.subscribe({ accessToken }); // the signed-in user's access token
  });
</script>
```

- `Run402Push.subscribe({ accessToken })` asks for permission the first time, subscribes this browser and records it for the signed-in user. Call it from a "Notify me" tap the first time, then again at start-up for a signed-in user: it never prompts again and re-confirms the subscription with the server at most once a day. A call from a tap always re-confirms. An app on the hosted sign-in cookie can omit `accessToken`.
- `Run402Push.status()` resolves without prompting to `unsupported`, `needs_install` (an iPhone outside its Home Screen app), `default` (not asked yet), `denied`, or `subscribed`. Show the button only for `default`, and an "add to Home Screen" hint for `needs_install`.
- `Run402Push.unsubscribe({ accessToken })` removes this browser's subscription.
- The helper registers its own service worker, `/_run402/push-sw.js`. If the app already has a service worker at its root, add `importScripts("/_run402/push-sw.js");` to it instead; `subscribe` rejects with `worker_missing_snippet` until you do.

Only a signed-in user can sign a phone up. Each user keeps up to 10 phones; signing up an 11th replaces the one whose app re-confirmed longest ago. A replaced phone signs back up when its user taps "Notify me", or by itself at the first start-up a day after its last re-confirmation.

**iPhone and iPad** (iOS/iPadOS 16.4 and later): push works only from the app added to the Home Screen, never from a Safari tab, and the permission prompt appears only after a tap. A "Don't Allow" is undone only by removing the Home Screen icon and adding it again. iOS 18.4 and later show Apple's Declarative Web Push format, which every message uses. **Android** works in a Chrome tab and in the installed app.

## Send (inside a function)

```ts
import { push } from "@run402/functions";

const sent = await push.send({
  title: "Your order shipped", // 1–100 characters
  body: "Arrives Thursday", // optional, up to 1000
  url: "/orders/123", // optional path the notification opens (default "/")
  tag: "order-123", // optional; a newer message with the same tag replaces the older one
  to: { user_id: order.user_id }, // optional; omit to reach every phone signed up to the project
});
// 202: { message_id: "pmsg_…", status: "queued", devices: 3 }
// 200: { message_id: "pmsg_…", status: "no_subscribers", devices: 0 }
```

`push.send` only queues the message; delivery happens after it returns. Failures throw `Run402PushError` with the gateway's `code`: `VALIDATION_FAILED` for a bad field, `QUOTA_EXCEEDED` (403) when the message does not fit today's cap, `RATE_LIMITED` (429) when sending too fast on team.

**The daily cap** counts deliveries (one message to three phones is three) per organization per UTC day: 100 on prototype, 1,000 on hobby, 10,000 on team. A message that does not fit is refused whole, never sent to some phones: `403 QUOTA_EXCEEDED` with `details: { resource: "push_deliveries_per_day", used, limit, resets_at }` and an upgrade next action. Team has no higher tier, so there the same refusal is `429 RATE_LIMITED` with `Retry-After` (seconds until UTC midnight).

## A worked example: notify once per gap

A dog-walking log wants one notification when four hours pass without a walk, not one every 15 minutes. A schedule trigger runs a function every 15 minutes, and an `alerted_at` column remembers which gap was already notified:

```json
{
  "database": {
    "migrations": [
      { "id": "001_dogs", "sql": "CREATE TABLE dogs (id bigint generated always as identity primary key, name text not null, last_walk_at timestamptz not null default now(), alerted_at timestamptz);" }
    ]
  },
  "functions": {
    "replace": {
      "walk-check": {
        "runtime": "node22",
        "source": { "path": "functions/walk-check.ts" },
        "triggers": [{ "id": "walk_check_15m", "type": "schedule", "cron": "*/15 * * * *", "run": { "event_type": "walk.check" } }]
      }
    }
  }
}
```

```ts
// functions/walk-check.ts
import { adminDb, push } from "@run402/functions";

export default async () => {
  // Claim each overdue gap first, so an overlapping run cannot notify twice.
  const { rows } = await adminDb().sql(
    `UPDATE dogs SET alerted_at = now()
      WHERE last_walk_at < now() - interval '4 hours'
        AND (alerted_at IS NULL OR alerted_at < last_walk_at)
      RETURNING id, name`,
  );
  for (const dog of rows) {
    await push.send({ title: dog.name, body: "4 hours since the last walk", tag: `walk-${dog.id}` });
  }
  return new Response("ok");
};
```

Logging a walk sets `last_walk_at` past `alerted_at`, which re-arms the next gap. Deploy with `run402 deploy --manifest run402.json`.

## Read the result and recover

`run402 push status` shows who is signed up (`subscriptions.users[].phones[]`, with each phone's `push_service`), today's `usage` against the cap, and the latest 10 messages with their `status` (`no_subscribers`, `queued`, `sending`, `completed`) and `outcomes` counts. `run402 push status --message <message_id>` lists every delivery: `accepted` (the push service took it), `retrying`, `failed` (with `last_status` and `last_error`), or `removed` (the push service said the phone is gone, so the platform deleted its subscription; that user signs up again from the app). An unknown message id, or another project's, is a 404.

- No phones listed: the user never completed `subscribe`, or signed up while signed out. On an iPhone, check that they opened the Home Screen app, not Safari.
- `accepted` but nothing on screen: the phone's own notification settings or focus mode hold it; the platform's part is done.
- `QUOTA_EXCEEDED`: wait for `resets_at`, or upgrade the organization's tier.
