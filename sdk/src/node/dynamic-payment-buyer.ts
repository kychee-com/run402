import { createHash } from "node:crypto";
import { Challenge, Credential } from "mppx";

import { LocalError } from "../errors.js";
import {
  PaymentBuyerError,
  RUN402_MPP_LIGHTNING_PROFILE,
  gatewayPaymentBuyerError,
  payResponseMetadata,
  readPaymentErrorEnvelope,
  responseSignalsReplay,
  type PayExecutor,
  type PayFetchResult,
  type PaymentBuyerErrorCode,
  type PaymentEvidencePolicy,
  type PaymentFlowResult,
  type PaymentPreference,
  type VerifiedPaymentAttestation,
} from "../namespaces/pay.js";
import {
  authenticationParameterObject,
  parseAuthenticationFields,
  type AuthenticationChallenge,
} from "./http-authentication-fields.js";
import {
  Bolt11PolicyError,
  RUN402_LIGHTNING_BUYER_BOLT11_POLICY,
  verifyStrictBolt11,
} from "./lightning-bolt11.js";
import {
  assertApprovedLightningWalletAdapter,
  type LightningWalletAdapter,
  type LightningWalletPaymentResult,
} from "./lightning-wallet-adapter.js";
import {
  LightningValuationError,
  authorizeLightningDebit,
  fetchLightningBuyerValuation,
  type LightningBuyerValuation,
  type LightningSellerQuote,
} from "./lightning-valuation.js";
import {
  PaymentAttestationVerificationError,
  fetchPaymentAttestationKeys,
  verifyOutcomeAttestationChain,
  verifyPaymentAttestation,
} from "./payment-attestation-verifier.js";
import {
  createFilePaymentAttemptStore,
  type PaymentAttemptRecord,
  type PaymentAttemptStore,
} from "./payment-attempts.js";

const MAX_BODY_BYTES = 1_048_576;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface LightningChallengeRequest {
  amount: string;
  currency: "sat";
  description: string;
  methodDetails: {
    invoice: string;
    paymentHash: string;
    network: "regtest" | "mainnet";
  };
}

interface ParsedLightningChallenge {
  raw: string;
  challenge: ReturnType<typeof Challenge.deserialize>;
  request: LightningChallengeRequest;
  intentId: string;
  attemptId: string;
  operationDigest: string;
  requestContractDigest: string;
  quoteDigest: string;
  paymentHash: string;
  invoice: string;
  invoiceAmountMsat: number;
  invoiceExpiryInstant: Date;
}

interface LightningDiscoveryBody {
  raw: Record<string, unknown>;
  intentId: string;
  attemptId: string;
  amountUsdMicros: number;
  challengeId: string;
  paymentHash: string;
  invoiceAmountMsat: number;
  invoiceExpiryInstant: Date;
  challengeExpiryInstant: Date;
  quote: LightningSellerQuote;
}

interface PreparedRequest {
  method: string;
  url: string;
  origin: string;
  headers: Headers;
  body: Uint8Array;
  bodySha256: string;
  contentDigest: string;
  semanticHeadersSha256: string;
  principalCredentialSha256: string | null;
  init: RequestInit;
}

export interface DynamicPaymentBuyerOptions {
  fetch?: typeof globalThis.fetch;
  x402?: PayExecutor | null;
  tempo?: PayExecutor | null;
  lightningWallets?: readonly LightningWalletAdapter[];
  store?: PaymentAttemptStore;
  now?: () => Date;
  valuation?: (quote: LightningSellerQuote) => Promise<LightningBuyerValuation>;
  attestationFetch?: typeof globalThis.fetch;
}

export function createDynamicPaymentBuyer(
  options: DynamicPaymentBuyerOptions,
): PayExecutor {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const store = options.store ?? createFilePaymentAttemptStore();
  const now = options.now ?? (() => new Date());
  const wallets = new Map<string, LightningWalletAdapter>();
  for (const wallet of options.lightningWallets ?? []) {
    assertApprovedLightningWalletAdapter(wallet);
    if (wallets.has(wallet.alias)) {
      throw new LocalError(
        "PAYMENT_WALLET_ALIAS_DUPLICATE",
        "configuring payment wallets",
        { code: "PAYMENT_WALLET_ALIAS_DUPLICATE" },
      );
    }
    wallets.set(wallet.alias, wallet);
  }
  const valuation = options.valuation ?? ((quote) => fetchLightningBuyerValuation({
    retainedSellerQuote: quote,
    fetchImpl,
    now,
  }));

  return async (url, init, payOptions): Promise<PayFetchResult> => {
    const preferences = payOptions.paymentPreferences;
    if (!preferences || preferences.length === 0) {
      const fallback = options.x402 ?? options.tempo;
      if (fallback) return fallback(url, init, payOptions);
      throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "No configured payment adapter matches this call.");
    }
    const prepared = await prepareRequest(url, init, payOptions.principalTransport);
    const lightningPreference = preferences.find((preference) =>
      preference.protocol === "mpp" && preference.method === "lightning");
    const localAttemptId = deterministicAttemptId(prepared.origin, payOptions.idempotencyKey ?? "");
    const existing = safeRead(store, localAttemptId);
    if (existing?.rail === "mpp_lightning") {
      assertSameRetainedCall(existing, prepared, payOptions, preferences);
      return recoverRetainedLightning({
        existing,
        prepared,
        payOptions,
        preferences,
        wallets,
        fetchImpl,
        store,
        now,
        attestationFetch: options.attestationFetch ?? fetchImpl,
      });
    }

    const discovery = await fetchImpl(prepared.url, prepared.init);
    if (discovery.status !== 402) {
      return responseWithoutPayment(discovery, payOptions.idempotencyKey !== undefined);
    }
    if (!isPinnedGatewayResponse(prepared, discovery)) {
      throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "The payment offer did not come from the exact requested origin.");
    }
    const paymentChallenges = parsePaymentChallenges(discovery);
    if (paymentChallenges.length === 0) {
      if (allowsX402(preferences) && options.x402) {
        return options.x402(url, init, payOptions);
      }
      if (allowsTempo(preferences) && options.tempo) {
        return options.tempo(url, init, payOptions);
      }
      throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "The returned payment offer is not supported by the ordered policy.");
    }
    if (paymentChallenges.length !== 1) {
      throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "The seller returned more than one actionable Payment offer.");
    }
    const selected = paymentChallenges[0]!;
    const params = authenticationParameterObject(selected);
    const method = params.method?.toLowerCase();
    const intent = params.intent?.toLowerCase();
    if (method === "tempo" && intent === "charge" && allowsTempo(preferences) && options.tempo) {
      return options.tempo(url, init, payOptions);
    }
    if (method !== "lightning" || intent !== "charge" || !lightningPreference ||
        payOptions.profile !== RUN402_MPP_LIGHTNING_PROFILE) {
      throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "The returned Payment offer violates the ordered policy.");
    }
    const walletAlias = lightningPreference.protocol === "mpp" &&
      lightningPreference.method === "lightning" ? lightningPreference.wallet : null;
    const wallet = walletAlias ? wallets.get(walletAlias) : null;
    if (!wallet) {
      throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "The selected Lightning instrument alias is not configured.", {
        wallet_alias: walletAlias,
      });
    }
    const body = await parseDiscoveryBody(discovery);
    const challenge = parseLightningChallenge(selected, body, prepared);
    if (wallet.network !== challenge.request.methodDetails.network) {
      throw buyerError("PAYMENT_INVOICE_INVALID", "The Lightning invoice network does not match the selected instrument.");
    }
    const boltPolicy = {
      ...RUN402_LIGHTNING_BUYER_BOLT11_POLICY,
      bitcoinNetwork: challenge.request.methodDetails.network,
      payeeNodePubkeys: wallet.payeeNodePubkeys,
    };
    try {
      verifyStrictBolt11({
        paymentRequest: challenge.invoice,
        expectedPaymentHash: challenge.paymentHash,
        expectedAmountMsat: BigInt(challenge.invoiceAmountMsat),
        policy: boltPolicy,
        now: now(),
      });
    } catch (error) {
      const details = error instanceof Bolt11PolicyError ? { reasons: error.errors } : {};
      throw buyerError("PAYMENT_INVOICE_INVALID", "The fixed Lightning invoice failed the approved policy.", details);
    }
    let market: LightningBuyerValuation;
    try {
      market = await valuation(body.quote);
      authorizeLightningDebit({
        invoiceAmountMsat: challenge.invoiceAmountMsat,
        authorizedMaxFeeMsat: payOptions.maxRoutingFeeMsat!,
        maxNativeAmountMsat: payOptions.maxNativeAmountMsat!,
        canonicalAmountUsdMicros: body.amountUsdMicros,
        maxUsdMicros: payOptions.maxUsdMicros,
        conservativeRateUsdMicrosPerBtc: market.conservativeRateUsdMicrosPerBtc,
      });
    } catch (error) {
      const code = error instanceof LightningValuationError ? error.code : "PAYMENT_QUOTE_SOURCE_UNAVAILABLE";
      throw buyerError(asBuyerCode(code), "The Lightning quote or all-in payment bound was not eligible.");
    }
    let preparedWallet;
    try {
      preparedWallet = await wallet.preparePayment({
        invoice: challenge.invoice,
        paymentHash: challenge.paymentHash,
        invoiceAmountMsat: challenge.invoiceAmountMsat,
        authorizedMaxFeeMsat: payOptions.maxRoutingFeeMsat!,
      });
    } catch (error) {
      const code = error instanceof Error && error.message === "PAYMENT_WALLET_FEE_CAP_UNSUPPORTED"
        ? "PAYMENT_WALLET_FEE_CAP_UNSUPPORTED" : "PAYMENT_CAPABILITY_UNAVAILABLE";
      throw buyerError(code, "The selected Lightning instrument could not prepare this payment.");
    }
    const createdAt = now().toISOString();
    const record: PaymentAttemptRecord = {
      version: 1,
      payment_attempt_id: localAttemptId,
      rail: "mpp_lightning",
      state: "intent",
      mutation_state: "not_started",
      method: prepared.method,
      origin: prepared.origin,
      path_sha256: requestTargetDigest(prepared.url),
      caller_key_sha256: sha256(payOptions.idempotencyKey!),
      profile_id: RUN402_MPP_LIGHTNING_PROFILE,
      preference_sha256: preferenceDigest(preferences),
      body_sha256: prepared.bodySha256,
      semantic_headers_sha256: prepared.semanticHeadersSha256,
      ...(prepared.principalCredentialSha256
        ? { principal_credential_sha256: prepared.principalCredentialSha256 } : {}),
      ...(payOptions.principalTransport ? { principal_transport: payOptions.principalTransport } : {}),
      ...(payOptions.organizationId
        ? { organization_id_sha256: sha256(payOptions.organizationId) } : {}),
      max_usd_micros: payOptions.maxUsdMicros,
      max_native_amount_msat: payOptions.maxNativeAmountMsat,
      max_routing_fee_msat: payOptions.maxRoutingFeeMsat,
      canonical_amount_usd_micros: body.amountUsdMicros,
      invoice_amount_msat: challenge.invoiceAmountMsat,
      selected_challenge: challenge.raw,
      challenge_id: body.challengeId,
      intent_id: body.intentId,
      provider_attempt_id: body.attemptId,
      operation_digest: challenge.operationDigest,
      request_contract_digest: challenge.requestContractDigest,
      payment_hash: challenge.paymentHash,
      invoice_sha256: sha256(challenge.invoice),
      invoice_expires_at: challenge.invoiceExpiryInstant.toISOString(),
      wallet_alias: wallet.alias,
      wallet_provider: wallet.provider,
      wallet_request_id: preparedWallet.walletRequestId,
      provider_state: "prepared",
      created_at: createdAt,
      updated_at: createdAt,
    };
    if (!store.claim(record)) {
      const raced = safeRead(store, localAttemptId);
      if (!raced || raced.rail !== "mpp_lightning") {
        throw buyerError("PAYMENT_STATE_UNAVAILABLE", "The retained local payment attempt could not be reconciled.", {}, "unknown");
      }
      return recoverRetainedLightning({
        existing: raced,
        prepared,
        payOptions,
        preferences,
        wallets,
        fetchImpl,
        store,
        now,
        attestationFetch: options.attestationFetch ?? fetchImpl,
      });
    }
    write(store, record, {
      state: "submitting",
      mutation_state: "in_progress",
      provider_state: "dispatched",
      provider_started_at: now().toISOString(),
    }, now);
    let walletResult: LightningWalletPaymentResult;
    try {
      walletResult = await preparedWallet.dispatch();
    } catch {
      write(store, record, {
        state: "ambiguous",
        mutation_state: "ambiguous",
        provider_state: "unknown",
        last_error_code: "PAYMENT_STATE_UNAVAILABLE",
      }, now);
      throw buyerError(
        "PAYMENT_STATE_UNAVAILABLE",
        "The Lightning instrument outcome is not yet final; reconcile this same intent.",
        retainedDetails(record),
        "unknown",
      );
    }
    return finishWalletResult({
      record: safeRead(store, localAttemptId) ?? record,
      walletResult,
      prepared,
      payOptions,
      store,
      now,
      fetchImpl,
      attestationFetch: options.attestationFetch ?? fetchImpl,
      dispatchedNow: true,
    });
  };
}

async function recoverRetainedLightning(input: {
  existing: PaymentAttemptRecord;
  prepared: PreparedRequest;
  payOptions: Parameters<PayExecutor>[2];
  preferences: readonly PaymentPreference[];
  wallets: ReadonlyMap<string, LightningWalletAdapter>;
  fetchImpl: typeof globalThis.fetch;
  store: PaymentAttemptStore;
  now: () => Date;
  attestationFetch: typeof globalThis.fetch;
}): Promise<PayFetchResult> {
  const wallet = input.existing.wallet_alias
    ? input.wallets.get(input.existing.wallet_alias) : null;
  if (!wallet) {
    throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "The retained Lightning instrument is unavailable.", retainedDetails(input.existing));
  }
  if (input.existing.state === "completed") {
    const replay = await input.fetchImpl(input.prepared.url, input.prepared.init);
    return parseLightningResponse(replay, input.existing, input.payOptions.evidencePolicy ?? "none", {
      fundsMoved: false,
      attestationFetch: input.attestationFetch,
    });
  }
  if (!input.existing.payment_hash) {
    throw buyerError("PAYMENT_STATE_UNAVAILABLE", "The retained Lightning attempt is incomplete.", retainedDetails(input.existing), "unknown");
  }
  let result: LightningWalletPaymentResult;
  try {
    result = await wallet.lookupPayment({
      paymentHash: input.existing.payment_hash,
      walletRequestId: input.existing.wallet_request_id ?? null,
    });
  } catch {
    result = {
      state: "unknown",
      paymentHash: input.existing.payment_hash,
      walletRequestId: input.existing.wallet_request_id ?? null,
      invoiceAmountMsat: null,
      feesPaidMsat: null,
      totalDebitMsat: null,
      failureCode: "NWC_LOOKUP_UNAVAILABLE",
    };
  }
  return finishWalletResult({
    record: input.existing,
    walletResult: result,
    prepared: input.prepared,
    payOptions: input.payOptions,
    store: input.store,
    now: input.now,
    fetchImpl: input.fetchImpl,
    attestationFetch: input.attestationFetch,
    dispatchedNow: false,
  });
}

async function finishWalletResult(input: {
  record: PaymentAttemptRecord;
  walletResult: LightningWalletPaymentResult;
  prepared: PreparedRequest;
  payOptions: Parameters<PayExecutor>[2];
  store: PaymentAttemptStore;
  now: () => Date;
  fetchImpl: typeof globalThis.fetch;
  attestationFetch: typeof globalThis.fetch;
  dispatchedNow: boolean;
}): Promise<PayFetchResult> {
  const result = input.walletResult;
  if (result.state !== "settled" || !result.preimageHex) {
    write(input.store, input.record, {
      state: "ambiguous",
      mutation_state: "ambiguous",
      provider_state: result.state === "failed" ? "failed" : result.state,
      last_error_code: result.failureCode ?? "PAYMENT_STATE_UNAVAILABLE",
    }, input.now);
    const gateway = await input.fetchImpl(input.prepared.url, input.prepared.init).catch(() => null);
    if (gateway) {
      const envelope = await readPaymentErrorEnvelope(gateway);
      if (envelope && isPinnedGatewayResponse(input.prepared, gateway)) {
        throw gatewayErrorWithLocalFunds(gateway, envelope, "unknown");
      }
    }
    throw buyerError(
      "PAYMENT_STATE_UNAVAILABLE",
      "The Lightning payment remains pinned to this intent until the wallet and gateway report a final state.",
      retainedDetails(input.record),
      "unknown",
    );
  }
  validateFinalWalletDebit(result, input.record, input.payOptions.maxNativeAmountMsat!);
  const preimage = Buffer.from(result.preimageHex, "hex");
  try {
    const derived = createHash("sha256").update(preimage).digest("hex");
    if (derived !== input.record.payment_hash) {
      throw buyerError("PAYMENT_STATE_UNAVAILABLE", "The wallet result does not match the retained payment hash.", retainedDetails(input.record), "unknown");
    }
    const challenge = Challenge.deserialize(input.record.selected_challenge!);
    const authorization = Credential.serialize(Credential.from({
      challenge,
      payload: { preimage: result.preimageHex },
    }));
    const headers = new Headers(input.prepared.headers);
    headers.set("Authorization", authorization);
    const response = await input.fetchImpl(input.prepared.url, {
      ...input.prepared.init,
      headers,
      redirect: "error",
    }).catch((cause) => {
      write(input.store, input.record, {
        state: "ambiguous",
        mutation_state: "ambiguous",
        provider_state: "settled",
        last_error_code: "PAYMENT_RECOVERY_PENDING",
      }, input.now);
      throw buyerError(
        "PAYMENT_RECOVERY_PENDING",
        "The wallet settled, but the identical HTTP operation still needs reconciliation.",
        retainedDetails(input.record),
        input.dispatchedNow ? true : "unknown",
        cause,
      );
    });
    const parsed = await parseLightningResponse(
      response,
      input.record,
      input.payOptions.evidencePolicy ?? "none",
      { fundsMoved: input.dispatchedNow, attestationFetch: input.attestationFetch },
    );
    if (response.ok) {
      write(input.store, input.record, {
        state: "completed",
        mutation_state: "completed",
        provider_state: "settled",
        response_status: response.status,
      }, input.now);
    }
    return parsed;
  } finally {
    preimage.fill(0);
  }
}

async function parseLightningResponse(
  response: Response,
  record: PaymentAttemptRecord,
  evidencePolicy: PaymentEvidencePolicy,
  options: { fundsMoved: boolean | "unknown"; attestationFetch: typeof globalThis.fetch },
): Promise<PayFetchResult> {
  if (!isPinnedGatewayResponse({ origin: record.origin! }, response)) {
    throw buyerError(
      "PAYMENT_RECOVERY_PENDING",
      "The payment response did not come from the retained origin.",
      retainedDetails(record),
      options.fundsMoved,
    );
  }
  const envelope = await readPaymentErrorEnvelope(response);
  if (!response.ok) {
    if (envelope && isPinnedGatewayResponse({ origin: record.origin! } as PreparedRequest, response)) {
      throw gatewayErrorWithLocalFunds(response, envelope, options.fundsMoved);
    }
    throw buyerError(
      "PAYMENT_RECOVERY_PENDING",
      "The settled Lightning payment has not produced a terminal operation result.",
      retainedDetails(record),
      options.fundsMoved,
    );
  }
  if (!envelope) {
    throw buyerError("PAYMENT_EVIDENCE_INVALID", "The Lightning success response is not a JSON object.", retainedDetails(record), options.fundsMoved);
  }
  const paymentResult = await paymentFlowFromBody(
    response,
    envelope,
    record,
    evidencePolicy,
    options.attestationFetch,
    options.fundsMoved,
  );
  return {
    response,
    payment: null,
    paymentResult,
    outcome: "settled",
    replay: paymentResult.replay,
    paymentId: paymentResult.intentId,
    fundsMoved: options.fundsMoved,
    intentState: paymentResult.operationState,
    nextActions: [],
  };
}

async function paymentFlowFromBody(
  response: Response,
  body: Record<string, unknown>,
  record: PaymentAttemptRecord,
  evidencePolicy: PaymentEvidencePolicy,
  attestationFetch: typeof globalThis.fetch,
  fundsMoved: boolean | "unknown",
): Promise<PaymentFlowResult> {
  const state = recordObject(body.payment_state);
  const fulfillment = recordObject(body.fulfillment);
  if (!fulfillment) {
    throw buyerError("MERCHANT_RECEIPT_UNAVAILABLE", "The Lightning success response omitted its retained fulfillment.", retainedDetails(record), fundsMoved);
  }
  const headerPaymentReceipt = response.headers.get("payment-receipt");
  const fulfillmentPaymentReceipt = stringField(fulfillment, "payment_receipt");
  if (!headerPaymentReceipt) {
    throw buyerError("PAYMENT_EVIDENCE_INVALID", "The Lightning success response omitted its Payment-Receipt.", retainedDetails(record), fundsMoved);
  }
  if (fulfillmentPaymentReceipt !== headerPaymentReceipt) {
    throw buyerError("PAYMENT_EVIDENCE_INVALID", "The retained fulfillment and Payment-Receipt header do not match.", retainedDetails(record), fundsMoved);
  }
  validatePaymentReceipt(headerPaymentReceipt, record);
  validateSuccessContract(body, state, record, fundsMoved);
  let settlementAttestation: VerifiedPaymentAttestation | null = null;
  let outcomeAttestations: VerifiedPaymentAttestation[] = [];
  const attestationRows = Array.isArray(body.attestations) ? body.attestations : [];
  if (evidencePolicy === "run402_settlement" || evidencePolicy === "merchant_fulfillment") {
    try {
      const keys = await fetchPaymentAttestationKeys({ origin: record.origin!, fetchImpl: attestationFetch });
      const verified = attestationRows.map((row) => {
        const item = recordObject(row);
        const kind = item?.kind;
        const compactJws = stringField(item, "compact_jws");
        if ((kind !== "settlement" && kind !== "outcome") || !compactJws) {
          throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
        }
        return verifyPaymentAttestation({
          compactJws,
          kind,
          keys,
          issuer: record.origin!,
        });
      });
      settlementAttestation = verified.find((item) => item.kind === "settlement") ?? null;
      outcomeAttestations = verified.filter((item) => item.kind === "outcome");
      if (!settlementAttestation || outcomeAttestations.length === 0) {
        throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
      }
      verifyOutcomeAttestationChain(outcomeAttestations);
      if (settlementAttestation.claims.intent_id !== record.intent_id ||
          settlementAttestation.claims.attempt_id !== record.provider_attempt_id ||
          settlementAttestation.claims.payment_hash !== record.payment_hash ||
          settlementAttestation.claims.profile_id !== record.profile_id ||
          settlementAttestation.claims.protocol !== "mpp" ||
          settlementAttestation.claims.method !== "lightning" ||
          settlementAttestation.claims.intent !== "charge" ||
          settlementAttestation.claims.amount_usd_micros !== String(record.canonical_amount_usd_micros) ||
          settlementAttestation.claims.invoice_amount_msat !== String(record.invoice_amount_msat) ||
          outcomeAttestations.some((item) => item.claims.intent_id !== record.intent_id)) {
        throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
      }
      const latest = latestOutcome(outcomeAttestations);
      if (stringField(fulfillment, "settlement_attestation") !== settlementAttestation.compactJws ||
          stringField(fulfillment, "outcome_attestation") !== latest?.compactJws) {
        throw new PaymentAttestationVerificationError("PAYMENT_EVIDENCE_INVALID");
      }
    } catch (error) {
      const code = error instanceof PaymentAttestationVerificationError &&
        error.code === "PAYMENT_EVIDENCE_UNAVAILABLE"
        ? "PAYMENT_EVIDENCE_UNAVAILABLE" : "PAYMENT_EVIDENCE_INVALID";
      throw buyerError(code, "The Run402 payment attestations could not be verified.", retainedDetails(record), fundsMoved);
    }
  }
  return {
    protocol: "mpp",
    method: "lightning",
    intent: "charge",
    profile: RUN402_MPP_LIGHTNING_PROFILE,
    intentId: record.intent_id ?? null,
    attemptId: record.provider_attempt_id ?? null,
    canonicalAmountUsdMicros: record.canonical_amount_usd_micros ?? null,
    invoiceAmountMsat: record.invoice_amount_msat ?? null,
    receivedAmountMsat: safeIntegerString(state?.received_amount_msat),
    excessAmountMsat: safeIntegerString(state?.excess_amount_msat),
    paymentHash: record.payment_hash ?? null,
    fundsMoved,
    rawNodeState: nodeState(state?.raw_node_state),
    terminality: terminality(state?.terminality),
    settlementRole: settlementRole(state?.settlement_role),
    operationState: stringField(latestOutcome(outcomeAttestations)?.claims ?? null, "operation_state") ??
      stringField(fulfillment, "status") ?? "succeeded",
    recoveryState: stringField(latestOutcome(outcomeAttestations)?.claims ?? null, "recovery_state") ??
      stringField(state, "recovery"),
    replay: body.payment_replay === true,
    paymentReceipt: headerPaymentReceipt,
    settlementAttestation,
    outcomeAttestations,
    merchantFulfillment: fulfillment,
    currentStatus: body.current_status ?? null,
    credits: Array.isArray(body.credits) ? body.credits : [],
  };
}

function validateSuccessContract(
  body: Record<string, unknown>,
  state: Record<string, unknown> | null,
  record: PaymentAttemptRecord,
  fundsMoved: boolean | "unknown",
): void {
  const fulfillment = recordObject(body.fulfillment);
  const paymentIdentity = recordObject(fulfillment?.payment_identity);
  const canonicalAmount = safeIntegerString(body.amount_usd_micros);
  const invoiceAmount = safeIntegerString(state?.invoice_amount_msat);
  const receivedAmount = safeIntegerString(state?.received_amount_msat);
  const excessAmount = safeIntegerString(state?.excess_amount_msat);
  if (body.profile !== RUN402_MPP_LIGHTNING_PROFILE || body.protocol !== "mpp" ||
      body.method !== "lightning" || body.intent !== "charge" ||
      body.intent_id !== record.intent_id || body.attempt_id !== record.provider_attempt_id ||
      body.payment_hash !== record.payment_hash ||
      canonicalAmount !== record.canonical_amount_usd_micros ||
      invoiceAmount !== record.invoice_amount_msat || receivedAmount === null ||
      excessAmount === null || state?.raw_node_state !== "SETTLED" ||
      state?.terminality !== "terminal_paid" || state?.settlement_role !== "primary" ||
      fulfillment?.status !== "succeeded" ||
      paymentIdentity?.rail !== "mpp" || paymentIdentity?.method !== "lightning" ||
      paymentIdentity?.intent !== "charge" || paymentIdentity?.payment_hash !== record.payment_hash ||
      paymentIdentity?.request_contract_digest !== record.request_contract_digest ||
      !recordObject(body.current_status) || !Array.isArray(body.credits)) {
    throw buyerError(
      "PAYMENT_EVIDENCE_INVALID",
      "The Lightning success response does not match the retained payment and fulfillment contract.",
      retainedDetails(record),
      fundsMoved,
    );
  }
  assertNoPrivatePaymentMaterial(body, record, fundsMoved);
}

function assertNoPrivatePaymentMaterial(
  value: unknown,
  record: PaymentAttemptRecord,
  fundsMoved: boolean | "unknown",
): void {
  const excludedNames = new Set([
    "authorization", "cookie", "credential", "identity_key", "nwc_uri",
    "payment_secret", "preimage", "private_key", "seed", "signed_proof",
  ]);
  const inspect = (item: unknown): boolean => {
    if (Array.isArray(item)) return item.some(inspect);
    if (!item || typeof item !== "object") return false;
    return Object.entries(item as Record<string, unknown>).some(([name, nested]) =>
      excludedNames.has(name.toLowerCase()) || inspect(nested));
  };
  if (inspect(value)) {
    throw buyerError(
      "PAYMENT_EVIDENCE_INVALID",
      "The Lightning response included private payment material.",
      retainedDetails(record),
      fundsMoved,
    );
  }
}

async function prepareRequest(
  url: string,
  init: RequestInit | undefined,
  principalTransport: "siwx" | "control_plane_cookie" | undefined,
): Promise<PreparedRequest> {
  if (init?.body instanceof ReadableStream) {
    throw buyerError("PAYMENT_BODY_NOT_REPLAYABLE", "The paid request body must be replayable bytes.");
  }
  const headers = new Headers(init?.headers);
  if (headers.has("content-encoding")) {
    throw buyerError("PAYMENT_BODY_NOT_REPLAYABLE", "Content-Encoding is not supported by the Lightning charge profile.");
  }
  let request: Request;
  try {
    request = new Request(url, { ...init, headers, redirect: "error" });
  } catch (cause) {
    throw buyerError("PAYMENT_BODY_NOT_REPLAYABLE", "The paid request could not be constructed.", {}, false, cause);
  }
  let body: Uint8Array;
  try {
    body = new Uint8Array(await request.clone().arrayBuffer());
  } catch (cause) {
    throw buyerError("PAYMENT_BODY_NOT_REPLAYABLE", "The paid request body could not be buffered.", {}, false, cause);
  }
  if (body.byteLength > MAX_BODY_BYTES) {
    throw buyerError("PAYMENT_BODY_TOO_LARGE", "The paid request body exceeds the Lightning replay limit.", {
      maximum_bytes: MAX_BODY_BYTES,
    });
  }
  const bodySha256 = sha256(body);
  const contentDigest = `sha-256=:${Buffer.from(bodySha256, "hex").toString("base64")}:`;
  const suppliedDigest = headers.get("content-digest");
  if (suppliedDigest && suppliedDigest !== contentDigest) {
    throw buyerError("PAYMENT_BODY_NOT_REPLAYABLE", "Content-Digest does not match the exact request bytes.");
  }
  headers.set("Content-Digest", contentDigest);
  const parsedUrl = new URL(request.url);
  const credentials = principalTransport === "control_plane_cookie" ? "include" : "omit";
  return {
    method: request.method,
    url: request.url,
    origin: parsedUrl.origin,
    headers,
    body,
    bodySha256,
    contentDigest,
    semanticHeadersSha256: semanticHeadersDigest(headers),
    principalCredentialSha256: headers.has("sign-in-with-x")
      ? sha256(headers.get("sign-in-with-x")!) : null,
    init: {
      method: request.method,
      headers,
      body: body.byteLength > 0 ? Buffer.from(body) : undefined,
      redirect: "error",
      credentials,
    },
  };
}

function parsePaymentChallenges(response: Response): AuthenticationChallenge[] {
  const value = response.headers.get("www-authenticate");
  if (!value) return [];
  try {
    return parseAuthenticationFields([value]).challenges.filter((challenge) =>
      challenge.normalizedScheme === "payment" && challenge.token68 === null);
  } catch {
    throw buyerError("PAYMENT_CAPABILITY_UNAVAILABLE", "The Payment challenge field is malformed.");
  }
}

async function parseDiscoveryBody(response: Response): Promise<LightningDiscoveryBody> {
  const raw = await readPaymentErrorEnvelope(response);
  if (!raw) throw buyerError("PAYMENT_INVOICE_INVALID", "The Lightning challenge body is missing.");
  const quote = recordObject(raw.quote);
  if (!quote) throw buyerError("PAYMENT_INVOICE_INVALID", "The Lightning quote is missing.");
  const result = {
    raw,
    intentId: requiredString(raw, "intent_id"),
    attemptId: requiredString(raw, "attempt_id"),
    amountUsdMicros: requiredSafeInteger(raw.amount_usd_micros),
    challengeId: requiredString(raw, "challenge_id"),
    paymentHash: requiredHash(raw, "payment_hash"),
    invoiceAmountMsat: requiredSafeInteger(raw.invoice_amount_msat),
    invoiceExpiryInstant: requiredDate(raw, "invoice_expires_at"),
    challengeExpiryInstant: requiredDate(raw, "challenge_expires_at"),
    quote: {
      source: requiredString(quote, "source") as LightningSellerQuote["source"],
      sourceReference: requiredString(quote, "source_reference"),
      sourceObservationInstant: requiredDate(quote, "observed_at"),
      rateNumerator: requiredPositiveBigInt(quote, "rate_usd_micros_per_btc_numerator"),
      rateDenominator: requiredPositiveBigInt(quote, "rate_usd_micros_per_btc_denominator"),
      spreadBps: requiredSafeInteger(quote.spread_bps),
      quoteInstant: requiredDate(quote, "quoted_at"),
      quoteExpiryInstant: requiredDate(quote, "valid_until"),
    },
  };
  if (raw.profile !== RUN402_MPP_LIGHTNING_PROFILE || raw.protocol !== "mpp" ||
      raw.method !== "lightning" || raw.intent !== "charge" ||
      result.quote.source !== "coinbase_exchange_btc_usd_bid_v1" || result.invoiceAmountMsat <= 0 ||
      result.amountUsdMicros <= 0 || result.challengeExpiryInstant > result.invoiceExpiryInstant) {
    throw buyerError("PAYMENT_INVOICE_INVALID", "The Lightning challenge quote is invalid.");
  }
  return result;
}

function parseLightningChallenge(
  selected: AuthenticationChallenge,
  body: LightningDiscoveryBody,
  prepared: PreparedRequest,
): ParsedLightningChallenge {
  let challenge: ReturnType<typeof Challenge.deserialize>;
  try { challenge = Challenge.deserialize(selected.raw); } catch {
    throw buyerError("PAYMENT_INVOICE_INVALID", "The selected Lightning challenge cannot be decoded.");
  }
  const request = challenge.request as unknown as LightningChallengeRequest;
  const opaque = recordObject(challenge.opaque);
  const amountSat = requiredSafeInteger(request?.amount);
  const invoiceAmountMsat = amountSat * 1_000;
  if (!Number.isSafeInteger(invoiceAmountMsat) || request?.currency !== "sat" ||
      typeof request?.description !== "string" || !request.methodDetails ||
      (request.methodDetails.network !== "regtest" &&
        request.methodDetails.network !== "mainnet") ||
      !SHA256_HEX.test(request.methodDetails.paymentHash) ||
      typeof request.methodDetails.invoice !== "string" ||
      challenge.method !== "lightning" || challenge.intent !== "charge" ||
      challenge.realm !== new URL(prepared.url).host ||
      challenge.digest !== prepared.contentDigest.replace(/^sha-256=:/, "sha-256=").replace(/:$/, "") ||
      challenge.id !== body.challengeId || request.methodDetails.paymentHash !== body.paymentHash ||
      invoiceAmountMsat !== body.invoiceAmountMsat ||
      opaque?.intent !== body.intentId || opaque?.attempt !== body.attemptId ||
      typeof opaque?.operation !== "string" || !SHA256_HEX.test(opaque.operation) ||
      typeof opaque?.contract !== "string" || !SHA256_HEX.test(opaque.contract) ||
      typeof opaque?.quote !== "string" || !SHA256_HEX.test(opaque.quote)) {
    throw buyerError("PAYMENT_INVOICE_AMOUNT_MISMATCH", "The Lightning challenge and retained quote do not match.");
  }
  const expires = challenge.expires ? new Date(challenge.expires) : null;
  if (!expires || !Number.isFinite(expires.getTime()) ||
      expires.getTime() !== body.challengeExpiryInstant.getTime()) {
    throw buyerError("PAYMENT_INVOICE_INVALID", "The Lightning challenge expiry is invalid.");
  }
  return {
    raw: selected.raw,
    challenge,
    request,
    intentId: body.intentId,
    attemptId: body.attemptId,
    operationDigest: opaque.operation,
    requestContractDigest: opaque.contract,
    quoteDigest: opaque.quote,
    paymentHash: body.paymentHash,
    invoice: request.methodDetails.invoice,
    invoiceAmountMsat,
    invoiceExpiryInstant: body.invoiceExpiryInstant,
  };
}

function validateFinalWalletDebit(
  result: LightningWalletPaymentResult,
  record: PaymentAttemptRecord,
  maxNativeAmountMsat: number,
): void {
  if (result.paymentHash !== record.payment_hash || result.invoiceAmountMsat === null ||
      result.feesPaidMsat === null || result.totalDebitMsat === null ||
      result.invoiceAmountMsat + result.feesPaidMsat !== result.totalDebitMsat ||
      result.totalDebitMsat > maxNativeAmountMsat) {
    throw buyerError("PAYMENT_STATE_UNAVAILABLE", "The final Lightning wallet debit did not match the retained authorization.", retainedDetails(record), "unknown");
  }
}

function validatePaymentReceipt(value: string, record: PaymentAttemptRecord): void {
  let receipt: Record<string, unknown>;
  try {
    receipt = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw buyerError("PAYMENT_EVIDENCE_INVALID", "The Payment-Receipt is invalid.");
  }
  if (receipt.method !== "lightning" || receipt.challengeId !== record.challenge_id ||
      receipt.reference !== record.payment_hash || receipt.status !== "success" ||
      typeof receipt.timestamp !== "string" || !Number.isFinite(new Date(receipt.timestamp).getTime())) {
    throw buyerError("PAYMENT_EVIDENCE_INVALID", "The Payment-Receipt does not match the retained Lightning attempt.");
  }
}

function assertSameRetainedCall(
  record: PaymentAttemptRecord,
  prepared: PreparedRequest,
  payOptions: Parameters<PayExecutor>[2],
  preferences: readonly PaymentPreference[],
): void {
  const mismatches: string[] = [];
  if (record.method !== prepared.method) mismatches.push("method");
  if (record.origin !== prepared.origin) mismatches.push("origin");
  if (record.path_sha256 !== requestTargetDigest(prepared.url)) mismatches.push("path_and_query");
  if (record.body_sha256 !== prepared.bodySha256) mismatches.push("body");
  if (record.semantic_headers_sha256 !== prepared.semanticHeadersSha256) mismatches.push("semantic_headers");
  if ((record.principal_credential_sha256 ?? null) !== prepared.principalCredentialSha256) {
    mismatches.push("principal");
  }
  if ((record.principal_transport ?? null) !== (payOptions.principalTransport ?? null)) {
    mismatches.push("principal_transport");
  }
  if ((record.organization_id_sha256 ?? null) !==
      (payOptions.organizationId ? sha256(payOptions.organizationId) : null)) {
    mismatches.push("organization");
  }
  if (record.caller_key_sha256 !== sha256(payOptions.idempotencyKey!)) mismatches.push("idempotency_key");
  if (record.profile_id !== payOptions.profile) mismatches.push("profile");
  if (record.preference_sha256 !== preferenceDigest(preferences)) mismatches.push("payment_preferences");
  if (record.max_usd_micros !== payOptions.maxUsdMicros) mismatches.push("max_usd_micros");
  if (record.max_native_amount_msat !== payOptions.maxNativeAmountMsat) mismatches.push("max_native_amount_msat");
  if (record.max_routing_fee_msat !== payOptions.maxRoutingFeeMsat) mismatches.push("max_routing_fee_msat");
  if (mismatches.length > 0) {
    throw buyerError("IDEMPOTENCY_KEY_REUSED", "The retained payment intent belongs to a different request contract.", {
      mismatch_fields: mismatches,
      payment_attempt_id: record.payment_attempt_id,
    });
  }
}

function write(
  store: PaymentAttemptStore,
  record: PaymentAttemptRecord,
  patch: Partial<PaymentAttemptRecord>,
  now: () => Date,
): PaymentAttemptRecord {
  const next = { ...record, ...patch, updated_at: now().toISOString() };
  store.write(next);
  return next;
}

function safeRead(store: PaymentAttemptStore, id: string): PaymentAttemptRecord | null {
  try { return store.read(id); } catch {
    throw buyerError("PAYMENT_STATE_UNAVAILABLE", "The retained local payment attempt cannot be inspected.", {
      payment_attempt_id: id,
    }, "unknown");
  }
}

function isPinnedGatewayResponse(prepared: Pick<PreparedRequest, "origin">, response: Response): boolean {
  if (response.redirected) return false;
  if (!response.url) return false;
  try { return new URL(response.url).origin === prepared.origin; } catch { return false; }
}

function gatewayErrorWithLocalFunds(
  response: Response,
  envelope: Record<string, unknown>,
  fundsMoved: boolean | "unknown",
): PaymentBuyerError {
  const mapped = gatewayPaymentBuyerError(response, { ...envelope, funds_moved: fundsMoved });
  if (mapped) return mapped;
  const code = typeof envelope.code === "string" ? asBuyerCode(envelope.code) : "PAYMENT_RECOVERY_PENDING";
  return buyerError(
    code,
    typeof envelope.message === "string" ? envelope.message : code,
    envelope,
    fundsMoved,
  );
}

function buyerError(
  code: PaymentBuyerErrorCode,
  message: string,
  details: Record<string, unknown> = {},
  fundsMoved: boolean | "unknown" = false,
  cause?: unknown,
): PaymentBuyerError {
  return new PaymentBuyerError({
    code,
    message,
    fundsMoved,
    details,
    safeToRetry: fundsMoved === false,
    retryable: code === "PAYMENT_STATE_UNAVAILABLE" || code === "PAYMENT_RECOVERY_PENDING",
    nextActions: fundsMoved === false ? [] : [{
      type: "retry",
      request: "repeat_identical",
      reuse_payer: true,
      reuse_idempotency_key: true,
      why: "Resupply the identical request and stable key to reconcile this payment intent.",
    }],
    ...(cause !== undefined ? { cause } : {}),
  });
}

function asBuyerCode(value: string): import("../namespaces/pay.js").PaymentBuyerErrorCode {
  const known = new Set([
    "PAYMENT_CAPABILITY_UNAVAILABLE", "PAYMENT_PROFILE_INVALID", "PAYMENT_BODY_NOT_REPLAYABLE",
    "PAYMENT_BODY_TOO_LARGE", "PAYMENT_INVOICE_INVALID", "PAYMENT_INVOICE_AMOUNT_MISMATCH",
    "PAYMENT_QUOTE_EXPIRED", "PAYMENT_QUOTE_SOURCE_UNAVAILABLE", "PAYMENT_QUOTE_DIVERGED",
    "PAYMENT_NATIVE_AMOUNT_EXCEEDS_MAX", "PAYMENT_USD_AMOUNT_EXCEEDS_MAX",
    "PAYMENT_WALLET_FEE_CAP_UNSUPPORTED", "PAYMENT_STATE_UNAVAILABLE",
    "PAYMENT_RECOVERY_PENDING", "PAYMENT_CREDITED", "PAYMENT_MANUAL_REVIEW",
    "PAYMENT_EVIDENCE_UNAVAILABLE", "PAYMENT_EVIDENCE_INVALID", "IDEMPOTENCY_KEY_REUSED",
  ]);
  return (known.has(value) ? value : "PAYMENT_RECOVERY_PENDING") as import("../namespaces/pay.js").PaymentBuyerErrorCode;
}

function responseWithoutPayment(response: Response, inspectReplay: boolean): Promise<PayFetchResult> {
  return responseSignalsReplay(response, inspectReplay).then((replay) => ({
    response,
    payment: null,
    paymentResult: null,
    outcome: "not_required" as const,
    replay,
    ...payResponseMetadata(response),
  }));
}

function allowsX402(preferences: readonly PaymentPreference[]): boolean {
  return preferences.some((preference) => preference.protocol === "x402");
}

function allowsTempo(preferences: readonly PaymentPreference[]): boolean {
  return preferences.some((preference) =>
    preference.protocol === "mpp" && preference.method === "tempo");
}

function preferenceDigest(preferences: readonly PaymentPreference[]): string {
  return sha256(JSON.stringify(preferences));
}

function deterministicAttemptId(origin: string, idempotencyKey: string): string {
  return `pat_${sha256(`run402_lightning_attempt_v1:${origin}:${idempotencyKey}`).slice(0, 32)}`;
}

function requestTargetDigest(url: string): string {
  const parsed = new URL(url);
  return sha256(`${parsed.pathname}${parsed.search}`);
}

function semanticHeadersDigest(headers: Headers): string {
  const selected = ["content-language", "content-type", "run402-payment-profile"]
    .flatMap((name) => {
      const value = headers.get(name)?.trim();
      return value ? [[name, value] as const] : [];
    });
  return sha256(JSON.stringify(selected));
}

function retainedDetails(record: PaymentAttemptRecord): Record<string, unknown> {
  return {
    payment_attempt_id: record.payment_attempt_id,
    intent_id: record.intent_id ?? null,
    attempt_id: record.provider_attempt_id ?? null,
    payment_hash: record.payment_hash ?? null,
    provider_state: record.provider_state ?? null,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function requiredString(value: Record<string, unknown> | null, field: string): string {
  const item = value?.[field];
  if (typeof item !== "string" || item.length === 0) {
    throw buyerError("PAYMENT_INVOICE_INVALID", `The Lightning response is missing ${field}.`);
  }
  return item;
}

function stringField(value: Record<string, unknown> | null, field: string): string | null {
  const item = value?.[field];
  return typeof item === "string" && item.length > 0 ? item : null;
}

function requiredHash(value: Record<string, unknown>, field: string): string {
  const item = requiredString(value, field).toLowerCase();
  if (!SHA256_HEX.test(item)) throw buyerError("PAYMENT_INVOICE_INVALID", `${field} is invalid.`);
  return item;
}

function requiredSafeInteger(value: unknown): number {
  const number = safeIntegerString(value);
  if (number === null || number < 0) throw buyerError("PAYMENT_INVOICE_INVALID", "A Lightning amount is invalid.");
  return number;
}

function safeIntegerString(value: unknown): number | null {
  const parsed = typeof value === "number" ? value :
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requiredPositiveBigInt(value: Record<string, unknown> | null, field: string): bigint {
  const item = value?.[field];
  if (typeof item !== "string" || !/^\d+$/.test(item) || BigInt(item) <= 0n) {
    throw buyerError("PAYMENT_INVOICE_INVALID", `${field} is invalid.`);
  }
  return BigInt(item);
}

function requiredDate(value: Record<string, unknown> | null, field: string): Date {
  const item = requiredString(value, field);
  const date = new Date(item);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== item) {
    throw buyerError("PAYMENT_INVOICE_INVALID", `${field} is invalid.`);
  }
  return date;
}

function nodeState(value: unknown): PaymentFlowResult["rawNodeState"] {
  return new Set(["OPEN", "ACCEPTED", "SETTLED", "CANCELED", "UNKNOWN"]).has(String(value))
    ? value as PaymentFlowResult["rawNodeState"] : null;
}

function terminality(value: unknown): PaymentFlowResult["terminality"] {
  return new Set(["nonterminal", "terminal_paid", "terminal_unpaid", "unknown"]).has(String(value))
    ? value as PaymentFlowResult["terminality"] : null;
}

function settlementRole(value: unknown): PaymentFlowResult["settlementRole"] {
  return new Set(["none", "primary", "non_primary"]).has(String(value))
    ? value as PaymentFlowResult["settlementRole"] : null;
}

function latestOutcome(
  outcomes: readonly VerifiedPaymentAttestation[],
): VerifiedPaymentAttestation | null {
  return [...outcomes].sort((left, right) =>
    Number(left.claims.outcome_sequence) - Number(right.claims.outcome_sequence)).at(-1) ?? null;
}
