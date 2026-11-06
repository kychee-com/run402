/**
 * Response types for the `push` namespace — the agent-side check on a
 * project's push notifications (`GET /projects/v1/:project_id/push` and
 * `GET /projects/v1/:project_id/push/messages/:message_id`), and the Firebase
 * key its phone app's devices are reached with
 * (`/projects/v1/:project_id/push/providers/fcm`).
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

/** One device a phone app registered with its native session. Never carries the token. */
export interface PushDevice {
  /** `pdev_…`. */
  device_id: string;
  /** `fcm` (Firebase Cloud Messaging). */
  provider: "fcm";
  created_at: string;
  /** When the app last registered this token. */
  last_confirmed_at: string;
  /** When Firebase last accepted a delivery to it; null until one is. */
  last_accepted_at: string | null;
}

/** A user and the devices their phone app registered (up to 10). */
export interface PushDeviceUser {
  user_id: string;
  devices: PushDevice[];
}

/** Phone-app devices whose native session is live. */
export interface PushDevicesSummary {
  total: number;
  users: PushDeviceUser[];
  users_shown: number;
  users_total: number;
  has_more: boolean;
}

/** The project's Firebase key, by its public fields. Never the key. */
export interface PushFcmCredentialView {
  provider: "fcm";
  firebase_project_id: string;
  client_email: string | null;
  key_id: string;
  set_at: string;
  /** What Google last said when it refused the key; null while it works. */
  last_error: string | null;
  last_error_at: string | null;
}

/** `providers` in the status read: `configured: false` until a key is set. */
export interface PushProviders {
  fcm: ({ configured: true } & PushFcmCredentialView) | { configured: false };
}

/** `POST /projects/v1/:project_id/push/providers/fcm`. */
export interface PushFcmCredential extends PushFcmCredentialView {
  /** Devices removed because the key names another Firebase project. */
  devices_removed: number;
  next_actions?: Array<{ type: string; method?: string; path?: string; why?: string }>;
}

/** `DELETE /projects/v1/:project_id/push/providers/fcm`. */
export interface PushFcmRemoval {
  provider: "fcm";
  status: "removed";
  devices_removed: number;
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
  /** The Firebase key for the phone app's devices. */
  providers: PushProviders;
  subscriptions: PushSubscriptionsSummary;
  /** The phone app's devices. */
  devices: PushDevicesSummary;
  usage: PushUsage;
  /** The latest 10 messages, newest first. */
  messages: PushMessageSummary[];
}

/** One message's delivery to one browser (`kind: "web"`) or phone-app device (`kind: "native"`). */
export interface PushDelivery {
  kind: "web" | "native";
  /** Set on a web delivery. */
  subscription_id?: string;
  /** Set on a native delivery. */
  device_id?: string;
  /** Set on a native delivery: `fcm`. */
  provider?: "fcm";
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
  /** Null for a message that carried only `data`. */
  title: string | null;
  body: string | null;
  /** What phone apps' devices received; null when none was sent. */
  data: Record<string, string> | null;
  url: string | null;
  tag: string | null;
  /** The addressed user; null when the message went to every signed-up phone. */
  to: { user_id: string } | null;
  deliveries: PushDelivery[];
  deliveries_shown: number;
  /** true when `deliveries` is a leading page of `devices`. */
  has_more: boolean;
}
