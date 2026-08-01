import bolt11, { type PaymentRequestObject, type TagData } from "bolt11";

export type LightningBitcoinNetwork = "regtest" | "signet" | "testnet" | "mainnet";

export interface StrictBolt11Policy {
  bitcoinNetwork: LightningBitcoinNetwork;
  payeeNodePubkeys: readonly string[];
  invoiceMaxCharacters: number;
  amountMinMsat: bigint;
  amountMaxMsat: bigint;
  invoiceLifetimeSeconds: number;
  dispatchFloorSeconds: number;
  minFinalCltvExpiry: number;
  maxFinalCltvExpiry: number;
  descriptionMaxBytes: number;
  allowedOptionalFeatureBits: readonly number[];
  requiredFeatureBits: readonly number[];
  requiredFeatureDependencies: Readonly<Record<number, number>>;
  ampFeatureBits: readonly number[];
}

/** Shared bounds; the buyer replaces network and payee set from the selected instrument. */
export const RUN402_LIGHTNING_BUYER_BOLT11_POLICY: StrictBolt11Policy = Object.freeze({
  bitcoinNetwork: "regtest",
  payeeNodePubkeys: Object.freeze([]),
  invoiceMaxCharacters: 4_096,
  amountMinMsat: 1_000n,
  amountMaxMsat: 100_000_000n,
  invoiceLifetimeSeconds: 300,
  dispatchFloorSeconds: 30,
  minFinalCltvExpiry: 18,
  maxFinalCltvExpiry: 144,
  descriptionMaxBytes: 256,
  // Exact feature shape emitted by the pinned LND v0.21.1-beta seller node.
  allowedOptionalFeatureBits: Object.freeze([8, 14, 17, 25]),
  requiredFeatureBits: Object.freeze([8, 14, 17, 25]),
  requiredFeatureDependencies: Object.freeze({ 14: 8, 17: 14, 25: 8 }),
  ampFeatureBits: Object.freeze([30, 31]),
});

const FEATURE_PAIRS: ReadonlyArray<readonly [string, number]> = [
  ["option_data_loss_protect", 0], ["initial_routing_sync", 2],
  ["option_upfront_shutdown_script", 4], ["gossip_queries", 6],
  ["var_onion_optin", 8], ["gossip_queries_ex", 10],
  ["option_static_remotekey", 12], ["payment_secret", 14],
  ["basic_mpp", 16], ["option_support_large_channel", 18],
];

const ALLOWED_BOLT11_TAGS = new Set([
  "payment_hash", "payment_secret", "description", "purpose_commit_hash",
  "expire_time", "min_final_cltv_expiry", "feature_bits", "payee_node_key",
]);

function invoiceNetwork(paymentRequest: string): LightningBitcoinNetwork | "unknown" {
  const lower = paymentRequest.toLowerCase();
  if (lower.startsWith("lnbcrt")) return "regtest";
  if (lower.startsWith("lntbs")) return "signet";
  if (lower.startsWith("lntb")) return "testnet";
  if (lower.startsWith("lnbc")) return "mainnet";
  return "unknown";
}

function tagValues(decoded: PaymentRequestObject, name: string): TagData[] {
  return decoded.tags.filter((tag) => tag.tagName === name).map((tag) => tag.data);
}

function featureBits(decoded: PaymentRequestObject): Set<number> {
  const tags = tagValues(decoded, "feature_bits");
  const bits = new Set<number>();
  if (tags.length !== 1 || typeof tags[0] !== "object" || Array.isArray(tags[0])) {
    return bits;
  }
  const features = tags[0] as Record<string, unknown>;
  for (const [name, evenBit] of FEATURE_PAIRS) {
    const feature = features[name] as { required?: boolean; supported?: boolean } | undefined;
    if (feature?.required) bits.add(evenBit);
    if (feature?.supported) bits.add(evenBit + 1);
  }
  const extra = features.extra_bits as { start_bit?: number; bits?: boolean[] } | undefined;
  if (Number.isInteger(extra?.start_bit) && Array.isArray(extra?.bits)) {
    extra.bits.forEach((set, index) => {
      if (set) bits.add(Number(extra.start_bit) + index);
    });
  }
  return bits;
}

export class Bolt11PolicyError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(`BOLT11_POLICY_REJECTED:${errors.join(",")}`);
    this.name = "Bolt11PolicyError";
  }
}

export interface VerifiedBolt11 {
  paymentHash: string;
  payeeNodePubkey: string;
  amountMsat: bigint;
  creationInstant: Date;
  expiryInstant: Date;
  expirySeconds: number;
  minFinalCltvExpiry: number;
  featureBits: number[];
}

export function verifyStrictBolt11(input: {
  paymentRequest: string;
  expectedPaymentHash: string;
  expectedAmountMsat: bigint;
  policy: StrictBolt11Policy;
  now?: Date;
}): VerifiedBolt11 {
  const policy = input.policy;
  const errors: string[] = [];
  let decoded: ReturnType<typeof bolt11.decode>;
  try {
    decoded = bolt11.decode(input.paymentRequest);
  } catch {
    throw new Bolt11PolicyError(["decode_failed"]);
  }
  if (input.paymentRequest.length > policy.invoiceMaxCharacters) errors.push("invoice_too_long");
  if (/[a-z]/.test(input.paymentRequest) && /[A-Z]/.test(input.paymentRequest)) {
    errors.push("mixed_case_not_allowed");
  }
  if (invoiceNetwork(input.paymentRequest) !== policy.bitcoinNetwork) errors.push("network_not_allowed");
  const payee = String(decoded.payeeNodeKey ?? "").toLowerCase();
  const allowedPayees = policy.payeeNodePubkeys.map((value) => value.toLowerCase());
  if (allowedPayees.length === 0 || !allowedPayees.includes(payee)) {
    errors.push("payee_not_allowed");
  }
  const amount = decoded.millisatoshis === null || decoded.millisatoshis === undefined
    ? null : BigInt(decoded.millisatoshis);
  if (amount === null || amount === 0n) errors.push("amount_required");
  if (amount !== null) {
    if (amount < policy.amountMinMsat) errors.push("amount_below_minimum");
    if (amount > policy.amountMaxMsat) errors.push("amount_above_maximum");
    if (amount % 1_000n !== 0n) errors.push("whole_satoshi_amount_required");
    if (amount !== input.expectedAmountMsat) errors.push("challenge_amount_mismatch");
  }
  const hashes = tagValues(decoded, "payment_hash").map(String);
  if (hashes.length !== 1) errors.push("single_payment_hash_required");
  if (hashes.length === 1 && hashes[0]!.toLowerCase() !== input.expectedPaymentHash.toLowerCase()) {
    errors.push("payment_hash_mismatch");
  }
  const paymentSecrets = tagValues(decoded, "payment_secret").map(String);
  if (paymentSecrets.length !== 1 || !/^[0-9a-f]{64}$/i.test(paymentSecrets[0] ?? "") ||
      /^0{64}$/.test(paymentSecrets[0] ?? "")) {
    errors.push("single_valid_payment_secret_required");
  }
  const descriptions = tagValues(decoded, "description").map(String);
  const descriptionHashes = tagValues(decoded, "purpose_commit_hash").map(String);
  if (descriptions.length + descriptionHashes.length !== 1) errors.push("single_description_required");
  if (descriptions.some((value) => Buffer.byteLength(value, "utf8") > policy.descriptionMaxBytes)) {
    errors.push("description_too_long");
  }
  const expiries = tagValues(decoded, "expire_time").map(Number);
  if (expiries.length !== 1 || expiries[0] !== policy.invoiceLifetimeSeconds) {
    errors.push("invoice_lifetime_mismatch");
  }
  const cltvs = tagValues(decoded, "min_final_cltv_expiry").map(Number);
  if (cltvs.length !== 1) errors.push("single_cltv_required");
  if (cltvs.length === 1 && cltvs[0]! < policy.minFinalCltvExpiry) errors.push("cltv_below_minimum");
  if (cltvs.length === 1 && cltvs[0]! > policy.maxFinalCltvExpiry) errors.push("cltv_above_maximum");
  const features = featureBits(decoded);
  for (const bit of features) {
    if (!policy.allowedOptionalFeatureBits.includes(bit)) errors.push(`feature_bit_not_allowed:${bit}`);
  }
  for (const bit of policy.requiredFeatureBits) {
    if (!features.has(bit)) errors.push(`feature_bit_required:${bit}`);
  }
  for (const [bit, dependency] of Object.entries(policy.requiredFeatureDependencies)) {
    if (features.has(Number(bit)) && !features.has(dependency)) {
      errors.push(`feature_dependency_missing:${bit}->${dependency}`);
    }
  }
  for (const bit of policy.ampFeatureBits) {
    if (features.has(bit)) errors.push(`amp_not_allowed:${bit}`);
  }
  if (tagValues(decoded, "routing_info").length > 0) errors.push("route_hints_not_allowed");
  if (decoded.tags.some((tag) => !ALLOWED_BOLT11_TAGS.has(tag.tagName))) errors.push("tag_not_allowed");
  const tagCounts = new Map<string, number>();
  for (const tag of decoded.tags) tagCounts.set(tag.tagName, (tagCounts.get(tag.tagName) ?? 0) + 1);
  for (const [name, count] of tagCounts) {
    if (count > 1) errors.push(`duplicate_tag:${name}`);
  }
  const timestamp = Number(decoded.timestamp);
  const expirySeconds = expiries[0] ?? 0;
  const expiryInstant = new Date((timestamp + expirySeconds) * 1_000);
  if (!Number.isFinite(timestamp) || !Number.isFinite(expiryInstant.getTime())) {
    errors.push("invoice_timestamp_invalid");
  } else if (expiryInstant.getTime() - (input.now ?? new Date()).getTime() < policy.dispatchFloorSeconds * 1_000) {
    errors.push("invoice_dispatch_window_too_short");
  }
  if (errors.length > 0) throw new Bolt11PolicyError([...new Set(errors)].sort());
  return {
    paymentHash: hashes[0]!.toLowerCase(),
    payeeNodePubkey: payee,
    amountMsat: amount!,
    creationInstant: new Date(timestamp * 1_000),
    expiryInstant,
    expirySeconds,
    minFinalCltvExpiry: cltvs[0]!,
    featureBits: [...features].sort((left, right) => left - right),
  };
}
