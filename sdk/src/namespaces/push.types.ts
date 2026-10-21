/**
 * Response types for the `push` namespace — the agent-side check on a
 * project's web push notifications (`GET /projects/v1/:project_id/push` and
 * `GET /projects/v1/:project_id/push/messages/:message_id`).
 *
 * A deployed function sends with `push.send(...)` from `@run402/functions`;
 * a signed-in end user signs a phone up from the app's own page. These reads
 * answer "who is signed up, how much of today's delivery cap is used, and did
 * my last messages land". They never carry a subscription's endpoint or
 * encryption keys.
 */

/** One phone or browser signed up to the app for a user. */
export interface PushPhone {
  /** `psub_…`. */
  subscription_id: string;
  /** The browser's push service host, e.g. `web.push.apple.com`, `fcm.googleapis.com`. */
  push_service: string;
  created_at: string;
  /** When the app last re-confirmed this subscription (a signed-in start-up re-subscribes). */
  last_confirmed_at: string;
  /** When the push service last accepted a delivery to it; null until one is. */
  last_accepted_at: string | null;
}

/** A signed-up user and their phones (up to 10 per user). */
export interface PushSubscriberUser {
  user_id: string;
  phones: PushPhone[];
}

export interface PushSubscriptionsSummary {
  /** Subscriptions (phones) across every user. */
  total: number;
  users: PushSubscriberUser[];
  users_shown: number;
  users_total: number;
  /** true when `users` is a leading page of `users_total`. */
  has_more: boolean;
}

/** Today's deliveries against the organization's daily cap (one UTC day). */
export interface PushUsage {
  deliveries_today: number;
  limit: number;
  /** The next UTC midnight. */
  resets_at: string;
  /** The cap is pooled across the organization's projects. */
  scope: "organization";
  org_id: string;
}

/**
 * A message's lifecycle: `no_subscribers` (nobody it addressed had a phone
 * signed up), `queued`, `sending`, then `completed` once every delivery is
 * terminal.
 */
export type PushMessageStatus = "no_subscribers" | "queued" | "sending" | "completed";

/**
 * One delivery's state. `removed` means the push service said the phone is
 * gone and the platform deleted its subscription.
 */
export type PushDeliveryStatus = "queued" | "retrying" | "accepted" | "removed" | "failed";

/** Deliveries of one message counted by {@link PushDeliveryStatus}. */
export interface PushOutcomes {
  queued: number;
  retrying: number;
  accepted: number;
  removed: number;
  failed: number;
}

/** A sent message as the status read lists it. */
export interface PushMessageSummary {
  /** `pmsg_…`. */
  message_id: string;
  created_at: string;
  status: PushMessageStatus;
  /** Subscriptions the message was addressed to. */
  devices: number;
  outcomes: PushOutcomes;
}

/** `GET /projects/v1/:project_id/push`. */
export interface PushStatus {
  project_id: string;
  subscriptions: PushSubscriptionsSummary;
  usage: PushUsage;
  /** The latest 10 messages, newest first. */
  messages: PushMessageSummary[];
}

/** One message's delivery to one subscription. */
export interface PushDelivery {
  subscription_id: string;
  user_id: string;
  push_service: string;
  status: PushDeliveryStatus;
  attempts: number;
  /** The push service's last HTTP status (201 is accepted); null before the first attempt. */
  last_status: number | null;
  last_error: string | null;
  updated_at: string;
}

/** `GET /projects/v1/:project_id/push/messages/:message_id`. */
export interface PushMessage extends PushMessageSummary {
  project_id: string;
  title: string;
  body: string | null;
  url: string | null;
  tag: string | null;
  /** The addressed user; null when the message went to every signed-up phone. */
  to: { user_id: string } | null;
  deliveries: PushDelivery[];
  deliveries_shown: number;
  /** true when `deliveries` is a leading page of `devices`. */
  has_more: boolean;
}
