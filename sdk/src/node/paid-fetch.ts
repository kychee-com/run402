/**
 * Node-only x402-wrapped fetch. Reads the allowance file, checks on-chain
 * USDC balances through independent RPC providers, and returns a fetch wrapper
 * that auto-signs 402 responses only when the requested chain has confirmed
 * funds.
 *
 * Balance reads are pre-payment, read-only operations. They may be retried and
 * failed over safely; a payment payload has not been created or submitted yet.
 * An exhausted RPC check is never represented as a zero balance.
 *
 * The viem / @x402/* / mppx imports live behind `./_paid-stack.ts` so the
 * SDK's direct surface to those packages is auditable from one file and the
 * packages can be declared as optional peer dependencies in package.json.
 *
 * Never calls `process.exit` — the SDK leaves exit-code decisions to the
 * CLI edge.
 */

import { readAllowance } from "../../core-dist/allowance.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AllowanceData, CredentialsProvider } from "../credentials.js";
import {
  LocalError,
  PaymentAttemptError,
  Run402Error,
  type PaymentAttemptPhase,
} from "../errors.js";
import { PaidStackUnavailable, loadMppStack, loadX402Stack } from "./_paid-stack.js";
import type { MppStack, X402Stack } from "./_paid-stack.js";
import {
  DEFAULT_PAYMENT_MAX_USD_MICROS,
  PaymentBuyerError,
  PaymentPolicyError,
  gatewayPaymentBuyerError,
  isTrustedRun402PaymentUrl,
  isTrustedRun402PendingResponse,
  payResponseMetadata,
  merchantReceiptRequiredError,
  paymentExceedsMaxError,
  readPaymentErrorEnvelope,
  responseSignalsReplay,
  walletUnavailableError,
  type PayExecutor,
  type PayFetchOptions,
  type PayFetchResult,
  type PaymentReceipt,
  type PaymentEvidenceStatus,
  type PaymentNextAction,
} from "../namespaces/pay.js";
import {
  attemptIdFromRequest,
  createFilePaymentAttemptStore,
  createPaymentAttemptId,
  hasPaymentAuthorization,
  requestSummary,
  withPaymentAttemptHeader,
  type PaymentAttemptRecord,
  type PaymentAttemptStore,
} from "./payment-attempts.js";

type FetchFn = typeof globalThis.fetch;
type RpcFailureReason = "timeout" | "rate_limited" | "network" | "rpc_error";

interface RpcClient {
  readContract: (args: unknown) => Promise<bigint>;
}

interface RpcAttemptFailure {
  provider_index: number;
  attempt: number;
  reason: RpcFailureReason;
}

interface BalanceRetryOptions {
  attemptsPerProvider?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

interface PaymentRequirementLike {
  network?: string;
  amount?: string;
  [key: string]: unknown;
}

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

export interface X402PaymentPayload {
  x402Version: number;
  resource?: X402PaymentRequired["resource"];
  accepted: X402PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface X402BuyerClient {
  createPaymentPayload(required: X402PaymentRequired): Promise<X402PaymentPayload>;
}

interface KnownBalance {
  status: "known";
  balance: bigint;
}

interface UnknownBalance {
  status: "unknown";
  error: X402BalanceError;
}

type BalanceState = KnownBalance | UnknownBalance;
type BalanceStates = Record<string, BalanceState>;

export type X402BalanceErrorCode =
  | "X402_RPC_TIMEOUT"
  | "X402_RPC_RATE_LIMITED"
  | "X402_RPC_UNAVAILABLE"
  | "X402_INSUFFICIENT_FUNDS";

/**
 * A machine-readable x402 balance-preflight failure.
 *
 * `safeToRetry` is true only for read-only RPC failures. A confirmed balance
 * miss is not retryable without changing wallet funds or payment requirements.
 * Both states are emitted before payment payload creation, so
 * `mutationState` is always `not_started`.
 */
export class X402BalanceError extends Run402Error {
  readonly kind = "local_error" as const;
  readonly code: X402BalanceErrorCode;
  readonly cause?: unknown;

  constructor(
    code: X402BalanceErrorCode,
    message: string,
    details: Record<string, unknown>,
    cause?: unknown,
  ) {
    const rpcFailure = code !== "X402_INSUFFICIENT_FUNDS";
    super(
      message,
      null,
      {
        error: code,
        message,
        code,
        category: rpcFailure ? "network" : "payment_required",
        source: "sdk",
        retryable: rpcFailure,
        safe_to_retry: rpcFailure,
        mutation_state: "not_started",
        details: {
          phase: "balance_preflight",
          payment_started: false,
          ...details,
        },
        next_actions: rpcFailure
          ? [
              {
                type: "retry",
                why: "Retry the identical request; no payment payload was created.",
              },
            ]
          : [
              {
                type: "fund_wallet",
                why: "Fund the configured allowance wallet on an accepted network, then retry.",
              },
            ],
      },
      "checking x402 USDC balance",
    );
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export type X402PaymentNetwork = "eip155:8453" | "eip155:84532";

/** Public-chain operations exposed to an opaque signer provider. */
export interface PaymentPublicClient {
  readContract(args: unknown): Promise<bigint>;
}

/**
 * Minimum EVM signer shape needed by x402. Implementations may keep key
 * material behind KMS/HSM boundaries; only the public payer address and
 * signing operation cross into the SDK.
 */
export interface EvmPaymentSigner {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
  readContract?(args: unknown): Promise<unknown>;
  signTransaction?(args: unknown): Promise<`0x${string}`>;
  getTransactionCount?(args: { address: `0x${string}` }): Promise<number>;
  estimateFeesPerGas?(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
}

/** Async, opaque x402 payer. Returning null means that network is unsupported. */
export interface EvmPaymentSignerProvider {
  getSigner(context: {
    network: X402PaymentNetwork;
    publicClient: PaymentPublicClient;
  }): Promise<EvmPaymentSigner | null>;
}

export type PaymentPayerSource =
  | "payment_signer"
  | "allowance_path"
  | "credentials"
  | "default_allowance";

/** Safe, key-free provenance for the payer selected by paid fetch. */
export interface PaymentPayerProvenance {
  readonly source: PaymentPayerSource;
  readonly rail: "x402" | "mpp";
  readonly payers: readonly {
    readonly address: string;
    readonly network?: X402PaymentNetwork;
  }[];
}

export type ConfiguredPaidFetch = FetchFn & {
  readonly payer: PaymentPayerProvenance;
  readonly pay?: PayExecutor;
  /** Refreshes mutable balance state without re-resolving the selected payer. */
  refreshBalances(): Promise<void>;
};

export type LazyPaidFetch = FetchFn & {
  /** Initializes the selected source if needed and returns public payer provenance only. */
  getPayer(): Promise<PaymentPayerProvenance | null>;
  /** Execute the receipt-bearing arbitrary-URL buyer flow. */
  pay: PayExecutor;
};

export interface PaidFetchOptions {
  /** Explicit local allowance file. When set, no other allowance is consulted. */
  allowancePath?: string;
  /** Auth provider whose optional allowance capability may also fund payments. */
  credentials?: Pick<CredentialsProvider, "readAllowance">;
  /** Explicit opaque x402 signer. Mutually exclusive with allowancePath. */
  paymentSigner?: EvmPaymentSignerProvider;
}

const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
const USDC_MAINNET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Independent public providers. Do not add credential-bearing URLs here.
const BASE_RPC_URLS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://1rpc.io/base",
] as const;
const BASE_SEPOLIA_RPC_URLS = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
  "https://base-sepolia.drpc.org",
] as const;

const DEFAULT_ATTEMPTS_PER_PROVIDER = 2;
const DEFAULT_BASE_DELAY_MS = 100;
const MAX_PENDING_POLICY_ERRORS = 32;
let warnedMissingDeps = false;
let policyErrorSequence = 0;
const policyErrors = new Map<string, X402BalanceError>();

let stackLoaders = {
  x402: loadX402Stack,
  mpp: loadMppStack,
};

/** @internal Test seam; not re-exported from `@run402/sdk/node`. */
export function _setPaidStackLoadersForTest(loaders?: {
  x402?: () => Promise<X402Stack>;
  mpp?: () => Promise<MppStack>;
}): void {
  stackLoaders = {
    x402: loaders?.x402 ?? loadX402Stack,
    mpp: loaders?.mpp ?? loadMppStack,
  };
}

interface TrackedPaymentContext {
  id: string;
  request: {
    method: string;
    origin: string | null;
    path_sha256: string | null;
    caller_key_sha256: string | null;
  };
  createdAt: string;
  phase: PaymentAttemptPhase;
  providerStarted: boolean;
  responseStatus: number | null;
  record: PaymentAttemptRecord | null;
  journalFailure: boolean;
  now: () => string;
}

interface TrackedPaidFetchOptions {
  store?: PaymentAttemptStore;
  createAttemptId?: () => string;
  now?: () => string;
  fetch?: FetchFn;
  classifyPaymentResponse?: (
    response: Response,
  ) => Promise<"completed" | "failed" | "already_settled" | "intent_pending" | "ambiguous">;
}

class AttemptJournalWriteError extends Error {
  constructor(readonly cause: unknown) {
    super("Could not persist the x402 payment attempt journal");
    this.name = "AttemptJournalWriteError";
  }
}

function classifyRpcFailure(err: unknown): RpcFailureReason {
  const record = err && typeof err === "object" ? (err as Record<string, unknown>) : null;
  const code = typeof record?.code === "string" ? record.code.toLowerCase() : "";
  const status = typeof record?.status === "number" ? record.status : null;
  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (
    code.includes("timeout") ||
    code === "etimedout" ||
    code === "abort_err" ||
    /timed? out|timeout|aborted/.test(message)
  ) {
    return "timeout";
  }
  if (status === 429 || code.includes("rate") || /rate.?limit|too many requests|\b429\b/.test(message)) {
    return "rate_limited";
  }
  if (
    code === "econnreset" ||
    code === "econnrefused" ||
    code === "enotfound" ||
    code === "eai_again" ||
    /network|connection|socket|dns|fetch failed/.test(message)
  ) {
    return "network";
  }
  return "rpc_error";
}

function exhaustedRpcCode(failures: RpcAttemptFailure[]): X402BalanceErrorCode {
  if (failures.length > 0 && failures.every((failure) => failure.reason === "timeout")) {
    return "X402_RPC_TIMEOUT";
  }
  if (failures.length > 0 && failures.every((failure) => failure.reason === "rate_limited")) {
    return "X402_RPC_RATE_LIMITED";
  }
  return "X402_RPC_UNAVAILABLE";
}

function delayForAttempt(baseDelayMs: number, retryIndex: number, random: () => number): number {
  const exponential = baseDelayMs * 2 ** retryIndex;
  return Math.round(exponential + exponential * 0.25 * random());
}

/** @internal Exported only for deterministic source-level tests; not re-exported by the package. */
export async function checkBalanceAcrossProviders(
  clients: readonly RpcClient[],
  tokenAddress: string,
  walletAddress: string,
  network: string,
  options: BalanceRetryOptions = {},
): Promise<bigint> {
  const attemptsPerProvider = options.attemptsPerProvider ?? DEFAULT_ATTEMPTS_PER_PROVIDER;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const failures: RpcAttemptFailure[] = [];
  let lastCause: unknown;

  for (let providerIndex = 0; providerIndex < clients.length; providerIndex += 1) {
    for (let attempt = 1; attempt <= attemptsPerProvider; attempt += 1) {
      if (attempt > 1) {
        await sleep(delayForAttempt(baseDelayMs, attempt - 2, random));
      }
      try {
        return await clients[providerIndex].readContract({
          address: tokenAddress,
          abi: USDC_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        });
      } catch (err) {
        lastCause = err;
        failures.push({
          provider_index: providerIndex,
          attempt,
          reason: classifyRpcFailure(err),
        });
      }
    }
  }

  const code = exhaustedRpcCode(failures);
  throw new X402BalanceError(
    code,
    `Unable to confirm the x402 USDC balance on ${network}; no zero balance was assumed.`,
    {
      network,
      balance_status: "unknown",
      providers_exhausted: true,
      providers_attempted: clients.length,
      attempts: failures,
    },
    lastCause,
  );
}

function bigintAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** @internal Exported only for deterministic source-level tests; not re-exported by the package. */
export function filterAffordableRequirements(
  requirements: PaymentRequirementLike[],
  balances: BalanceStates,
): PaymentRequirementLike[] {
  const recognized = requirements.filter(
    (requirement) => typeof requirement.network === "string" && requirement.network in balances,
  );
  const known = recognized.filter(
    (requirement): requirement is PaymentRequirementLike & { network: string; amount: string } =>
      typeof requirement.network === "string" &&
      balances[requirement.network]?.status === "known" &&
      bigintAmount(requirement.amount) !== null,
  );
  const affordable = known.filter((requirement) => {
    const state = balances[requirement.network] as KnownBalance;
    return state.balance >= (bigintAmount(requirement.amount) as bigint);
  });
  if (affordable.length > 0) return affordable;

  const unknown = recognized
    .map((requirement) => (typeof requirement.network === "string" ? balances[requirement.network] : undefined))
    .find((state): state is UnknownBalance => state?.status === "unknown");
  if (unknown) throw unknown.error;

  // Only call this confirmed-insufficient when every recognized requirement
  // had a valid amount and a successful authoritative balance read.
  if (recognized.length > 0 && known.length === recognized.length) {
    const balanceDetails = Object.fromEntries(
      Object.entries(balances)
        .filter((entry): entry is [string, KnownBalance] => entry[1].status === "known")
        .map(([network, state]) => [network, state.balance.toString()]),
    );
    throw new X402BalanceError(
      "X402_INSUFFICIENT_FUNDS",
      "The configured allowance wallet has insufficient confirmed USDC for the accepted x402 payment requirements.",
      {
        balances: balanceDetails,
        requirements: recognized.map((requirement) => ({
          network: requirement.network,
          amount: requirement.amount,
        })),
      },
    );
  }

  // Preserve the x402 library's invalid/unsupported-requirement behavior; it
  // would be unfaithful to label malformed input as a confirmed balance miss.
  return [];
}

function wrapPolicyError(error: X402BalanceError): Error {
  policyErrorSequence += 1;
  const token = `run402-x402-preflight-${policyErrorSequence}`;
  // @x402/fetch currently preserves the thrown message, so the outer wrapper
  // removes this entry immediately. Keep the relay bounded anyway: if a future
  // release rewrites messages, no process-lifetime sentinel leak can grow.
  if (policyErrors.size >= MAX_PENDING_POLICY_ERRORS) {
    const oldest = policyErrors.keys().next().value as string | undefined;
    if (oldest) policyErrors.delete(oldest);
  }
  policyErrors.set(token, error);
  return new Error(`${token}: ${error.message}`);
}

function unwrapPolicyError(error: unknown): X402BalanceError | null {
  const message = error instanceof Error ? error.message : "";
  const token = /run402-x402-preflight-\d+/.exec(message)?.[0];
  if (!token) return null;
  const structured = policyErrors.get(token) ?? null;
  policyErrors.delete(token);
  return structured;
}

function createRpcClients(
  stack: Awaited<ReturnType<typeof loadX402Stack>>,
  chain: unknown,
  urls: readonly string[],
): RpcClient[] {
  return urls.map((url) => stack.createPublicClient({ chain, transport: stack.http(url) }));
}

async function balanceState(
  clients: readonly RpcClient[],
  tokenAddress: string,
  walletAddress: string,
  network: string,
): Promise<BalanceState> {
  try {
    return {
      status: "known",
      balance: await checkBalanceAcrossProviders(clients, tokenAddress, walletAddress, network),
    };
  } catch (err) {
    if (err instanceof X402BalanceError) return { status: "unknown", error: err };
    throw err;
  }
}

export async function setupPaidFetch(options: PaidFetchOptions = {}): Promise<ConfiguredPaidFetch | null> {
  validatePaymentSource(options);

  // Malformed or missing selected local state degrades to an unwrapped 402,
  // but it never falls back to a different wallet source.
  const resolvedAllowance = options.paymentSigner ? null : await resolveAllowance(options);
  const allowance = resolvedAllowance?.allowance ?? null;
  if (!allowance && !options.paymentSigner) return null;

  try {
    if (allowance?.rail === "mpp") {
      const stack = await stackLoaders.mpp();
      const account = stack.privateKeyToAccount(allowance.privateKey as `0x${string}`);
      const mppx = stack.Mppx.create({
        polyfill: false,
        methods: [stack.tempo({ account })],
      });
      return withPayer(mppx.fetch, {
        source: resolvedAllowance!.source,
        rail: "mpp",
        payers: [{ address: allowance.address }],
      });
    }

    // Default: x402 on Base + Base Sepolia. Each chain has its own independent
    // provider list; one degraded chain does not erase a confirmed balance on
    // the other chain.
    const stack = await stackLoaders.x402();
    const mainnetClients = createRpcClients(stack, stack.base, BASE_RPC_URLS);
    const sepoliaClients = createRpcClients(stack, stack.baseSepolia, BASE_SEPOLIA_RPC_URLS);

    const [mainnetSigner, sepoliaSigner] = options.paymentSigner
      ? await Promise.all([
          options.paymentSigner.getSigner({ network: "eip155:8453", publicClient: mainnetClients[0] }),
          options.paymentSigner.getSigner({ network: "eip155:84532", publicClient: sepoliaClients[0] }),
        ])
      : localAllowanceSigners(stack, allowance!, mainnetClients[0], sepoliaClients[0]);

    if (!mainnetSigner && !sepoliaSigner) return null;

    const balances: BalanceStates = {};
    const refreshBalances = async (): Promise<void> => {
      const [mainnet, sepolia] = await Promise.all([
        mainnetSigner
          ? balanceState(mainnetClients, USDC_MAINNET, mainnetSigner.address, "eip155:8453")
          : null,
        sepoliaSigner
          ? balanceState(sepoliaClients, USDC_SEPOLIA, sepoliaSigner.address, "eip155:84532")
          : null,
      ]);
      if (mainnet) balances["eip155:8453"] = mainnet;
      else delete balances["eip155:8453"];
      if (sepolia) balances["eip155:84532"] = sepolia;
      else delete balances["eip155:84532"];
    };
    await refreshBalances();

    const client = new stack.x402Client();
    if (mainnetSigner) {
      client.register(
        "eip155:8453",
        new stack.ExactEvmScheme(stack.toClientEvmSigner(mainnetSigner, mainnetClients[0])),
      );
    }
    if (sepoliaSigner) {
      client.register(
        "eip155:84532",
        new stack.ExactEvmScheme(stack.toClientEvmSigner(sepoliaSigner, sepoliaClients[0])),
      );
    }
    client.registerPolicy((_version, requirements) => {
      try {
        return filterAffordableRequirements(requirements as PaymentRequirementLike[], balances);
      } catch (err) {
        // @x402/fetch currently wraps payment-creation errors in a plain Error.
        // A per-call token lets the outer wrapper restore the original typed
        // error without putting wallet or RPC details into the sentinel.
        if (err instanceof X402BalanceError) throw wrapPolicyError(err);
        throw err;
      }
    });

    const trackedFetch = createTrackedX402Fetch(
      (baseFetch, rawClient) => {
        const wrapped = stack.wrapFetchWithPayment(baseFetch, rawClient);
        return async (input, init) => {
          try {
            return await wrapped(input, init);
          } catch (err) {
            throw unwrapPolicyError(err) ?? err;
          }
        };
      },
      client,
    );
    const supportedNetworks = [
      ...(mainnetSigner ? ["eip155:8453"] : []),
      ...(sepoliaSigner ? ["eip155:84532"] : []),
    ];
    const buyer = createX402BuyerFetch(client as X402BuyerClient, {
      supportedNetworks,
      payerAddresses: [
        ...(mainnetSigner ? [mainnetSigner.address] : []),
        ...(sepoliaSigner ? [sepoliaSigner.address] : []),
      ],
      offerReceipt: stack.offerReceipt,
    });
    return withPayer(
      trackedFetch,
      {
        source: options.paymentSigner ? "payment_signer" : resolvedAllowance!.source,
        rail: "x402",
        payers: [
          ...(mainnetSigner ? [{ address: mainnetSigner.address, network: "eip155:8453" as const }] : []),
          ...(sepoliaSigner ? [{ address: sepoliaSigner.address, network: "eip155:84532" as const }] : []),
        ],
      },
      refreshBalances,
      buyer,
    );
  } catch (err) {
    // Missing optional peers are a stable local capability state. Other setup
    // failures are thrown so lazy initialization can try again on a later call
    // instead of permanently caching an unwrapped/degraded fetch.
    if (err instanceof PaidStackUnavailable) {
      if (!warnedMissingDeps) {
        warnedMissingDeps = true;
        console.warn(`[run402] ${err.message}`);
      }
      return null;
    }
    throw err;
  }
}

function isRetryableBalanceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; safeToRetry?: unknown };
  return (
    typeof candidate.code === "string" &&
    candidate.code.startsWith("X402_RPC_") &&
    candidate.safeToRetry === true
  );
}

function isBalancePreflightError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" &&
    (code.startsWith("X402_RPC_") || code === "X402_INSUFFICIENT_FUNDS");
}

function createLazyPaidFetchFrom(setup: () => Promise<FetchFn | null>): FetchFn {
  let cached: FetchFn | null | undefined;
  let initializing: Promise<FetchFn | null> | undefined;
  return async (input, init) => {
    if (cached === undefined) {
      initializing ??= setup()
        .then((initialized) => {
          cached = initialized;
          return initialized;
        })
        .finally(() => {
          initializing = undefined;
        });
      await initializing;
    }

    // Read `globalThis.fetch` fresh each call so test suites that override it
    // after the SDK is constructed still see their mocks.
    if (!cached) return globalThis.fetch(input, init);
    try {
      return await cached(input, init);
    } catch (err) {
      // A retryable RPC preflight never created a payment payload. Drop only
      // that failed initialization so the next call re-reads provider health.
      if (isRetryableBalanceError(err)) cached = undefined;
      throw err;
    }
  };
}

/**
 * Returns a fetch that lazily initializes the x402 wrapper on first call.
 * Failed initialization is not cached; concurrent first calls share one
 * attempt, and a later request can recover after transient RPC/setup failure.
 */
export function createLazyPaidFetch(options: PaidFetchOptions = {}): LazyPaidFetch {
  let cached: ConfiguredPaidFetch | undefined;
  let pending: Promise<ConfiguredPaidFetch | null> | undefined;
  let refreshBeforeNextCall = false;

  const initialize = async (): Promise<ConfiguredPaidFetch | null> => {
    if (cached === undefined) {
      pending ??= setupPaidFetch(options).finally(() => {
        pending = undefined;
      });
      const initialized = await pending;
      // Cache only a successful wrapper. Missing/recoverable local state is
      // retried on the next request instead of pinning an unwrapped fetch for
      // the lifetime of the client.
      if (initialized) cached = initialized;
    }
    return cached ?? null;
  };

  const lazy = async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    await initialize();
    // Read `globalThis.fetch` fresh each call so test suites that override
    // it after the SDK is constructed still see their mocks.
    if (cached) {
      if (refreshBeforeNextCall) {
        await cached.refreshBalances();
        refreshBeforeNextCall = false;
      }
      try {
        return await cached(input, init);
      } catch (err) {
        // Preserve the selected signer/address. Only mutable RPC-derived
        // balance state is refreshed before the caller's next retry.
        if (isBalancePreflightError(err)) refreshBeforeNextCall = true;
        throw err;
      }
    }
    return globalThis.fetch(input, init);
  };

  return Object.assign(lazy as FetchFn, {
    async getPayer(): Promise<PaymentPayerProvenance | null> {
      return (await initialize())?.payer ?? null;
    },
    async pay(
      url: string,
      init: RequestInit | undefined,
      payOptions: Parameters<PayExecutor>[2],
    ): Promise<PayFetchResult> {
      const configured = await initialize();
      if (configured?.pay) return configured.pay(url, init, payOptions);

      const response = await globalThis.fetch(url, init);
      if (response.status !== 402) {
        return {
          response,
          payment: null,
          outcome: "not_required",
          replay: await responseSignalsReplay(response, payOptions.idempotencyKey !== undefined),
          ...payResponseMetadata(response),
        };
      }
      if (configured?.payer.rail === "mpp") {
        throw paymentNetworkUnsupportedError(
          challengeNetworks(response),
          configured.payer.payers.flatMap((payer) => payer.network ? [payer.network] : []),
          { configured_rail: "mpp" },
        );
      }
      throw walletUnavailableError({ challenge_networks: challengeNetworks(response) });
    },
  });
}

function validatePaymentSource(options: PaidFetchOptions): void {
  if (options.paymentSigner && options.allowancePath) {
    throw new LocalError(
      "Configure exactly one explicit payment source: paymentSigner or allowancePath",
      "configuring paid fetch",
      {
        code: "PAYMENT_SOURCE_CONFLICT",
        details: { fields: ["paymentSigner", "allowancePath"] },
      },
    );
  }
}

async function resolveAllowance(options: PaidFetchOptions): Promise<{
  allowance: AllowanceData;
  source: Exclude<PaymentPayerSource, "payment_signer">;
} | null> {
  try {
    // An explicit payment path is authoritative even when auth uses a custom
    // credentials provider. Do not fall back if it is absent or malformed.
    if (options.allowancePath !== undefined) {
      const allowance = readAllowance(options.allowancePath);
      return allowance ? { allowance, source: "allowance_path" } : null;
    }

    // Once a credentials provider is supplied it is the only implicit payment
    // source. Providers without allowance capability fail closed; they never
    // inherit the process-global wallet.
    if (options.credentials !== undefined) {
      if (typeof options.credentials.readAllowance !== "function") return null;
      const allowance = await options.credentials.readAllowance();
      return allowance ? { allowance, source: "credentials" } : null;
    }

    // Direct setupPaidFetch()/createLazyPaidFetch() calls retain the Node
    // default for backwards compatibility.
    const allowance = readAllowance();
    return allowance ? { allowance, source: "default_allowance" } : null;
  } catch {
    return null;
  }
}

function withPayer(
  fetchFn: FetchFn,
  payer: PaymentPayerProvenance,
  refreshBalances: () => Promise<void> = async () => {},
  pay?: PayExecutor,
): ConfiguredPaidFetch {
  return Object.assign(fetchFn, { payer, refreshBalances, ...(pay ? { pay } : {}) });
}

function localAllowanceSigners(
  stack: X402Stack,
  allowance: AllowanceData,
  mainnetClient: PaymentPublicClient,
  sepoliaClient: PaymentPublicClient,
): [EvmPaymentSigner, EvmPaymentSigner] {
  const account = stack.privateKeyToAccount(allowance.privateKey as `0x${string}`);
  return [
    stack.toClientEvmSigner(account, mainnetClient) as EvmPaymentSigner,
    stack.toClientEvmSigner(account, sepoliaClient) as EvmPaymentSigner,
  ];
}

/** @internal Source-level unit-test seam; not re-exported by the package. */
export const __paidFetchInternals = {
  createLazyPaidFetchFrom,
};

interface X402BuyerFetchOptions extends TrackedPaidFetchOptions {
  supportedNetworks: readonly string[];
  payerAddresses?: readonly string[];
  offerReceipt?: X402OfferReceiptRuntime;
  verifyAtSeconds?: () => number;
}

interface X402OfferReceiptRuntime {
  extractOffersFromPaymentRequired: (required: unknown) => unknown[];
  decodeSignedOffers: (offers: unknown[]) => unknown[];
  findAcceptsObjectFromSignedOffer: (
    offer: unknown,
    accepts: unknown[],
  ) => unknown | undefined;
  isEIP712SignedOffer: (offer: unknown) => boolean;
  isEIP712SignedReceipt: (receipt: unknown) => boolean;
  verifyOfferSignatureEIP712: (
    offer: unknown,
  ) => Promise<{ signer: `0x${string}`; payload: Record<string, unknown> }>;
  verifyReceiptSignatureEIP712: (
    receipt: unknown,
  ) => Promise<{ signer: `0x${string}`; payload: Record<string, unknown> }>;
  extractReceiptFromResponse: (response: Response) => unknown | undefined;
}

interface VerifiedOffer {
  signed: unknown;
  decoded: Record<string, unknown>;
  requirement: X402PaymentRequirements;
  signer: string;
  relationship: "direct";
}

interface GuardedPaymentRequired {
  required: X402PaymentRequired;
  verifiedOffers: VerifiedOffer[];
}

interface CachedPaymentProof {
  headers: Record<string, string>;
  accepted: X402PaymentRequirements;
  offer: VerifiedOffer | null;
}

interface BuyerCallContext {
  fingerprint: string;
  requestUrl: string;
  maxUsdMicros: number;
  proof?: CachedPaymentProof;
  replayedProof: boolean;
  alreadySettled: boolean;
  requireReceipt: boolean;
}

/**
 * Receipt-bearing buyer orchestration over an already-configured x402 client.
 * Signed proofs live only in this SDK instance's memory. An ambiguous retry of
 * the identical request re-presents that proof; it never mints a replacement.
 */
export function createX402BuyerFetch(
  client: X402BuyerClient,
  options: X402BuyerFetchOptions,
): PayExecutor {
  const calls = new AsyncLocalStorage<BuyerCallContext>();
  const proofs = new Map<string, CachedPaymentProof>();
  const creatingProofs = new Map<string, Promise<CachedPaymentProof>>();

  const tracked = createTrackedX402Fetch(
    (baseFetch) => async (input, init) => {
      const call = calls.getStore();
      if (!call) {
        throw settlementError("The x402 buyer lost its request context before dispatch.", false);
      }
      const request = new Request(input, init);
      const cached = proofs.get(call.fingerprint);
      if (cached) {
        call.proof = cached;
        call.replayedProof = true;
        return baseFetch(withProof(request, cached.headers));
      }

      const retryRequest = request.clone();
      const firstResponse = await baseFetch(request);
      if (firstResponse.status !== 402) return firstResponse;

      const required = await decodePaymentRequired(firstResponse);
      const guarded = await guardPaymentRequired(
        required,
        options.supportedNetworks,
        call.maxUsdMicros,
        request.url,
        call.requireReceipt,
        options.offerReceipt,
        options.verifyAtSeconds?.() ?? Math.floor(Date.now() / 1000),
      );
      let pending = creatingProofs.get(call.fingerprint);
      if (!pending) {
        pending = createProof(client, guarded)
          .finally(() => creatingProofs.delete(call.fingerprint));
        creatingProofs.set(call.fingerprint, pending);
      }
      const proof = await pending;
      proofs.set(call.fingerprint, proof);
      call.proof = proof;
      return baseFetch(withProof(retryRequest, proof.headers));
    },
    client,
    {
      store: options.store,
      createAttemptId: options.createAttemptId,
      now: options.now,
      fetch: options.fetch,
      async classifyPaymentResponse(response) {
        const call = calls.getStore();
        const envelope = await readPaymentErrorEnvelope(response);
        if (call && isTrustedRun402PendingResponse({
          requestUrl: call.requestUrl,
          response,
          envelope,
          paymentBearing: true,
          redirectsDisabled: true,
        })) {
          return "intent_pending";
        }
        if (call && envelope && trustedRun402ResponseOrigin(call.requestUrl, response) &&
            gatewayPaymentBuyerError(response, envelope)) {
          return "failed";
        }
        const failure = await upstreamFailure(response);
        if (call?.replayedProof && isAlreadyUsedFailure(failure)) {
          call.alreadySettled = true;
          return "already_settled";
        }
        return isProvenNoSettlementFailure(failure) ? "failed" : "ambiguous";
      },
    },
  );

  return async (url, init, payOptions): Promise<PayFetchResult> => {
    const maxUsdMicros = payOptions.maxUsdMicros ?? DEFAULT_PAYMENT_MAX_USD_MICROS;
    const requireReceipt = payOptions.requireReceipt === true;
    const fingerprint = await paymentRequestFingerprint(
      url,
      init,
      maxUsdMicros,
      requireReceipt,
    );
    const call: BuyerCallContext = {
      fingerprint,
      requestUrl: url,
      maxUsdMicros,
      replayedProof: false,
      alreadySettled: false,
      requireReceipt,
    };

    try {
      const response = await calls.run(call, () => tracked(url, init));
      if (!call.proof) {
        return {
          response,
          payment: null,
          outcome: "not_required",
          replay: await responseSignalsReplay(response, payOptions.idempotencyKey !== undefined),
          ...payResponseMetadata(response),
        };
      }
      if (call.alreadySettled) {
        proofs.delete(fingerprint);
        return {
          response,
          payment: null,
          outcome: "already_settled",
          replay: true,
          ...payResponseMetadata(response),
        };
      }
      if (!response.ok) {
        const envelope = await readPaymentErrorEnvelope(response);
        if (envelope && trustedRun402ResponseOrigin(url, response)) {
          const gatewayError = gatewayPaymentBuyerError(response, envelope);
          if (gatewayError) throw gatewayError;
        }
        const failure = await upstreamFailure(response);
        proofs.delete(fingerprint);
        if (failure.code === "payment_insufficient_funds") {
          throw walletUnavailableError({
            upstream_code: failure.code,
            ...(failure.details ?? {}),
          });
        }
        throw settlementError(
          "The x402 payment proof was rejected before settlement.",
          false,
          {
            upstream_code: failure.code,
            ...(failure.x402Error ? { x402_error: failure.x402Error } : {}),
          },
        );
      }

      const payment = await receiptFromResponse(
        response,
        call.proof,
        url,
        requireReceipt,
        options.offerReceipt,
        options.payerAddresses ?? [],
      );
      proofs.delete(fingerprint);
      const result: PayFetchResult = {
        response,
        payment,
        outcome: "settled",
        replay: call.replayedProof,
        nextActions: [],
        ...payResponseMetadata(response),
      };
      if (
        requireReceipt &&
        payment.merchantReceipt.status !== "verified"
      ) {
        const recovery = receiptRecovery(
          url,
          response,
          payOptions.idempotencyKey,
        );
        throw new PaymentPolicyError({
          response,
          result,
          message:
            "The payment settled, but the promised merchant receipt could not be verified.",
          fundsMoved: payment.fundsMoved,
          mutationState:
            payment.delivery.status === "fulfilled" ? "committed" : "unknown",
          safeToRetry: recovery.safeToRetry,
          nextActions: recovery.nextActions,
        });
      }
      return result;
    } catch (cause) {
      if (cause instanceof PaymentBuyerError) throw cause;
      if (cause instanceof X402BalanceError) {
        if (cause.code === "X402_INSUFFICIENT_FUNDS") {
          throw walletUnavailableError(asRecord(cause.details));
        }
        throw settlementError(
          "The buyer could not confirm wallet funds before signing; no funds moved.",
          false,
          { upstream_code: cause.code, ...(asRecord(cause.details)) },
          cause,
          true,
        );
      }
      if (cause instanceof PaymentAttemptError) {
        const fundsMoved = cause.mutationState === "ambiguous" ? "unknown" : false;
        throw settlementError(
          fundsMoved === "unknown"
            ? "The payment-bearing request lost its response; settlement may have occurred. The same SDK instance retains the original proof for an identical retry."
            : "The payment attempt failed before funds could move.",
          fundsMoved,
          {
            payment_attempt_id: cause.paymentAttemptId,
            phase: cause.phase,
            provider_started: cause.providerStarted,
            upstream_code: cause.code,
          },
          cause,
          cause.safeToRetry,
          cause.nextActions,
        );
      }
      throw settlementError(
        "The x402 payment authorization could not be created; no funds moved.",
        false,
        {},
        cause,
      );
    }
  };
}

async function createProof(
  client: X402BuyerClient,
  guarded: GuardedPaymentRequired,
): Promise<CachedPaymentProof> {
  try {
    const payload = await client.createPaymentPayload(guarded.required);
    return {
      accepted: payload.accepted,
      offer:
        guarded.verifiedOffers.find((offer) =>
          sameRequirement(offer.requirement, payload.accepted)
        ) ?? null,
      headers: {
        [payload.x402Version === 1 ? "X-PAYMENT" : "PAYMENT-SIGNATURE"]: encodeBase64Json(payload),
      },
    };
  } catch (cause) {
    throw unwrapPolicyError(cause) ?? cause;
  }
}

async function guardPaymentRequired(
  required: X402PaymentRequired,
  supportedNetworks: readonly string[],
  maxUsdMicros: number,
  requestUrl: string,
  requireReceipt: boolean,
  offerReceipt: X402OfferReceiptRuntime | undefined,
  verifyAtSeconds: number,
): Promise<GuardedPaymentRequired> {
  let challengeUrl: string;
  try {
    challengeUrl = new URL(required.resource.url).toString();
  } catch (cause) {
    throw settlementError(
      "The x402 challenge resource URL is invalid.",
      false,
      { challenge_url: required.resource.url, request_url: requestUrl },
      cause,
    );
  }
  if (challengeUrl !== new URL(requestUrl).toString()) {
    throw settlementError(
      "The x402 challenge is bound to a different resource URL.",
      false,
      { challenge_url: challengeUrl, request_url: requestUrl },
    );
  }

  const supportedByNetwork = required.accepts.filter(
    (accept) => accept.scheme === "exact" && supportedNetworks.includes(accept.network),
  );
  if (supportedByNetwork.length === 0) {
    throw paymentNetworkUnsupportedError(
      [...new Set(required.accepts.map((accept) => accept.network))],
      [...supportedNetworks],
    );
  }
  const supported = supportedByNetwork.filter((accept) =>
    accept.asset.toLowerCase() === supportedPaymentAsset(accept.network)?.toLowerCase()
  );
  if (supported.length === 0) {
    throw paymentNetworkUnsupportedError(
      [...new Set(required.accepts.map((accept) => accept.network))],
      [...supportedNetworks],
      {
        challenge_assets: [...new Set(supportedByNetwork.map((accept) => accept.asset))],
        wallet_assets: [...new Set(supportedNetworks.flatMap((network) => {
          const asset = supportedPaymentAsset(network);
          return asset ? [asset] : [];
        }))],
      },
    );
  }
  const valid = supported.map((accept) => ({ accept, amount: atomicAmount(accept.amount) }));
  if (valid.some(({ amount }) => amount === null)) {
    throw settlementError(
      "The x402 challenge contains an invalid atomic amount.",
      false,
      { challenge_amounts: supported.map((accept) => accept.amount) },
    );
  }
  const withinLimit = valid.filter(
    (entry): entry is { accept: X402PaymentRequirements; amount: number } =>
      entry.amount !== null && entry.amount <= maxUsdMicros,
  );
  if (withinLimit.length === 0) {
    const challenged = Math.min(...valid.map(({ amount }) => amount as number));
    throw paymentExceedsMaxError(challenged, maxUsdMicros);
  }
  const accepted = withinLimit.map(({ accept }) => accept);
  const verifiedOffers = offerReceipt
    ? await verifyDirectOffers(
        required,
        accepted,
        requestUrl,
        verifyAtSeconds,
        offerReceipt,
      )
    : [];
  if (requireReceipt && verifiedOffers.length === 0) {
    throw merchantReceiptRequiredError({
      offered_requirements: accepted.length,
      valid_wallet_rooted_offers: 0,
    });
  }
  const eligible = requireReceipt
    ? accepted.filter((requirement) =>
        verifiedOffers.some((offer) =>
          sameRequirement(offer.requirement, requirement)
        )
      )
    : accepted;
  return {
    required: { ...required, accepts: eligible },
    verifiedOffers,
  };
}

function supportedPaymentAsset(network: string): string | null {
  if (network === "eip155:8453") return USDC_MAINNET;
  if (network === "eip155:84532") return USDC_SEPOLIA;
  return null;
}

async function verifyDirectOffers(
  required: X402PaymentRequired,
  eligibleRequirements: X402PaymentRequirements[],
  requestUrl: string,
  verifyAtSeconds: number,
  runtime: X402OfferReceiptRuntime,
): Promise<VerifiedOffer[]> {
  let decoded: unknown[];
  try {
    decoded = runtime.decodeSignedOffers(
      runtime.extractOffersFromPaymentRequired(required),
    );
  } catch {
    return [];
  }
  const verified: VerifiedOffer[] = [];
  for (const value of decoded) {
    const offer = asRecord(value);
    const signed = offer.signedOffer;
    if (!runtime.isEIP712SignedOffer(signed)) continue;
    const requirement = runtime.findAcceptsObjectFromSignedOffer(
      offer,
      eligibleRequirements,
    ) as X402PaymentRequirements | undefined;
    if (!requirement) continue;
    try {
      const checked = await runtime.verifyOfferSignatureEIP712(signed);
      const payload = checked.payload;
      const validUntil = safeInteger(payload.validUntil);
      if (
        payload.version !== 1 ||
        normalizedUrl(payload.resourceUrl) !== normalizedUrl(requestUrl) ||
        payload.scheme !== requirement.scheme ||
        payload.network !== requirement.network ||
        !sameAddressOrText(payload.asset, requirement.asset) ||
        payload.amount !== requirement.amount ||
        !sameAddressOrText(payload.payTo, requirement.payTo) ||
        validUntil === null ||
        validUntil <= verifyAtSeconds ||
        !sameAddressOrText(checked.signer, requirement.payTo)
      ) {
        continue;
      }
      verified.push({
        signed,
        decoded: offer,
        requirement,
        signer: checked.signer,
        relationship: "direct",
      });
    } catch {
      // A malformed, invalid, delegated, or untrusted offer is ineligible.
    }
  }
  return verified;
}

function sameRequirement(
  left: X402PaymentRequirements,
  right: X402PaymentRequirements,
): boolean {
  return (
    left.scheme === right.scheme &&
    left.network === right.network &&
    sameAddressOrText(left.asset, right.asset) &&
    left.amount === right.amount &&
    sameAddressOrText(left.payTo, right.payTo)
  );
}

function sameAddressOrText(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return /^0x[0-9a-fA-F]{40}$/.test(left) &&
      /^0x[0-9a-fA-F]{40}$/.test(right)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function normalizedUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function atomicAmount(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : null;
}

function withProof(request: Request, proofHeaders: Record<string, string>): Request {
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(proofHeaders)) headers.set(name, value);
  return new Request(request, { headers });
}

async function decodePaymentRequired(response: Response): Promise<X402PaymentRequired> {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    throw settlementError(
      "The 402 response did not include a PAYMENT-REQUIRED challenge header.",
      false,
    );
  }
  let decoded: unknown;
  try {
    decoded = decodeBase64Json(header);
  } catch (cause) {
    throw settlementError("The PAYMENT-REQUIRED challenge header is invalid.", false, {}, cause);
  }
  if (!isPaymentRequired(decoded)) {
    throw settlementError("The PAYMENT-REQUIRED challenge has an invalid shape.", false);
  }
  return decoded;
}

function isPaymentRequired(value: unknown): value is X402PaymentRequired {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<X402PaymentRequired>;
  return Number.isInteger(candidate.x402Version) &&
    Boolean(candidate.resource && typeof candidate.resource.url === "string") &&
    Array.isArray(candidate.accepts) &&
    candidate.accepts.every((accept) => Boolean(
      accept &&
      typeof accept.scheme === "string" &&
      typeof accept.network === "string" &&
      typeof accept.asset === "string" &&
      typeof accept.amount === "string" &&
      typeof accept.payTo === "string",
    ));
}

async function receiptFromResponse(
  response: Response,
  proof: CachedPaymentProof,
  url: string,
  requireReceipt: boolean,
  runtime: X402OfferReceiptRuntime | undefined,
  payerAddresses: readonly string[],
): Promise<PaymentReceipt> {
  const accepted = proof.accepted;
  const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (!header) {
    throw settlementError(
      "The paid response omitted the standard PAYMENT-RESPONSE settlement receipt, so settlement cannot be reported faithfully.",
      "unknown",
      { response_status: response.status },
    );
  }
  let settlement: unknown;
  try {
    settlement = decodeBase64Json(header);
  } catch (cause) {
    throw settlementError(
      "The PAYMENT-RESPONSE settlement receipt is invalid.",
      "unknown",
      { response_status: response.status },
      cause,
    );
  }
  const record = asRecord(settlement);
  if (record.success !== true || typeof record.transaction !== "string" || record.transaction === "") {
    throw settlementError(
      "The payment response does not prove a successful on-chain settlement.",
      record.success === false ? false : "unknown",
      { response_status: response.status },
    );
  }
  if (record.network !== accepted.network) {
    throw settlementError(
      "The payment response network does not match the accepted x402 challenge.",
      "unknown",
      {
        accepted_network: accepted.network,
        receipt_network: typeof record.network === "string" ? record.network : null,
        response_status: response.status,
      },
    );
  }
  const amount = atomicAmount(accepted.amount);
  if (amount === null) {
    throw settlementError("The selected payment amount cannot be represented as usd_micros.", "unknown");
  }
  const metadata = payResponseMetadata(response);
  const settlementPayer =
    typeof record.payer === "string" && record.payer.length > 0
      ? record.payer
      : null;
  let receiptStatus: PaymentEvidenceStatus = proof.offer
    ? "unavailable"
    : "absent";
  let signedReceipt: unknown | null = null;
  let receiptIssuedAt: string | null = null;
  let receiptSigner: string | null = null;
  if (runtime) {
    try {
      signedReceipt = runtime.extractReceiptFromResponse(response) ?? null;
      if (signedReceipt && !proof.offer) {
        receiptStatus = "untrusted";
      } else if (signedReceipt && !runtime.isEIP712SignedReceipt(signedReceipt)) {
        receiptStatus = "untrusted";
      } else if (signedReceipt && proof.offer) {
        const checked = await runtime.verifyReceiptSignatureEIP712(signedReceipt);
        const payload = checked.payload;
        const issuedAt = safeInteger(payload.issuedAt);
        const payerMatches =
          typeof payload.payer === "string" &&
          [
            ...(settlementPayer ? [settlementPayer] : []),
            ...payerAddresses,
          ].some((payer) => sameAddressOrText(payload.payer, payer));
        const transactionMatches =
          typeof payload.transaction === "string" &&
          payload.transaction === record.transaction;
        if (
          payload.version === 1 &&
          normalizedUrl(payload.resourceUrl) === normalizedUrl(url) &&
          payload.network === accepted.network &&
          payerMatches &&
          transactionMatches &&
          issuedAt !== null &&
          sameAddressOrText(checked.signer, proof.offer.signer) &&
          sameAddressOrText(checked.signer, accepted.payTo)
        ) {
          receiptStatus = "verified";
          receiptSigner = checked.signer;
          receiptIssuedAt = new Date(issuedAt * 1000).toISOString();
        } else {
          receiptStatus = "invalid";
        }
      }
    } catch {
      receiptStatus = signedReceipt ? "invalid" : receiptStatus;
    }
  }
  const fundsMoved = metadata.fundsMoved ?? true;
  const deliveryReplay =
    metadata.delivery === "replay" || metadata.deduplicated === true;
  const offerPayload = proof.offer?.decoded ?? null;
  const offerValidUntil = safeInteger(offerPayload?.validUntil);
  const noSignerAuthorizationExpiry: string | null = null;
  return {
    amount_usd_micros: amount,
    pay_to: accepted.payTo,
    network: record.network,
    tx_ref: record.transaction,
    url,
    paymentId: metadata.paymentId,
    amountUsdMicros: amount,
    asset: accepted.asset,
    payer: settlementPayer,
    payTo: accepted.payTo,
    transaction: record.transaction,
    resourceUrl: url,
    settlement: { status: "verified" },
    fundsMoved,
    deduplicated: metadata.deduplicated ?? false,
    delivery: {
      status: response.ok ? "fulfilled" : "failed",
      replay: deliveryReplay,
    },
    offer: {
      status: proof.offer ? "verified" : "absent",
      resourceUrl:
        typeof offerPayload?.resourceUrl === "string"
          ? offerPayload.resourceUrl
          : null,
      validUntil:
        offerValidUntil === null
          ? null
          : new Date(offerValidUntil * 1000).toISOString(),
    },
    merchantReceipt: {
      status: receiptStatus,
      claim: receiptStatus === "verified" ? "service_delivered" : null,
      issuedAt: receiptIssuedAt,
    },
    signerRelationship: {
      kind:
        receiptStatus === "verified"
          ? proof.offer?.relationship ?? null
          : proof.offer
            ? "unverified"
            : null,
      merchantRoot:
        proof.offer?.relationship === "direct" ? accepted.payTo : null,
      signer: receiptSigner ?? proof.offer?.signer ?? null,
      authorizationExpiresAt: noSignerAuthorizationExpiry,
    },
    policy: {
      requireReceipt,
      status: requireReceipt
        ? receiptStatus === "verified"
          ? "satisfied"
          : "unsatisfied"
        : "not_required",
    },
    evidence: {
      offer: proof.offer?.signed ?? null,
      merchantReceipt: signedReceipt,
      signerAuthorization: null,
    },
  };
}

function receiptRecovery(
  url: string,
  response: Response,
  idempotencyKey: string | undefined,
): { safeToRetry: boolean; nextActions: PaymentNextAction[] } {
  const recoverable =
    Boolean(idempotencyKey) &&
    isTrustedRun402PaymentUrl(url, { allowTestLocalhost: true }) &&
    response.headers.get("x-run402-merchant-evidence-state") ===
      "unavailable";
  if (recoverable) {
    return {
      safeToRetry: true,
      nextActions: [
        {
          type: "retry",
          request: "repeat_identical",
          reusePayer: true,
          reuseIdempotencyKey: true,
          why:
            "Repeat the identical request with the same payer and idempotency key to recover the original receipt without another settlement.",
        },
      ],
    };
  }
  return {
    safeToRetry: false,
    nextActions: [
      {
        type: "reconcile_payment",
        why:
          "Reconcile the existing settlement with the merchant; do not authorize a second payment.",
      },
    ],
  };
}

interface UpstreamPaymentFailure {
  code: string | null;
  x402Error: string | null;
  details: Record<string, unknown> | null;
}

async function upstreamFailure(response: Response): Promise<UpstreamPaymentFailure> {
  const challengeError = paymentRequiredError(response);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return { code: null, x402Error: challengeError, details: null };
  }
  try {
    const body = asRecord(await response.clone().json());
    const details = asRecord(body.details);
    return {
      code: typeof body.code === "string" ? body.code : null,
      x402Error: typeof details.x402_error === "string" ? details.x402_error : challengeError,
      details: Object.keys(details).length > 0 ? details : null,
    };
  } catch {
    return { code: null, x402Error: challengeError, details: null };
  }
}

function paymentRequiredError(response: Response): string | null {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return null;
  try {
    const decoded = asRecord(decodeBase64Json(header));
    return typeof decoded.error === "string" ? decoded.error : null;
  } catch {
    return null;
  }
}

function isAlreadyUsedFailure(failure: UpstreamPaymentFailure): boolean {
  if (failure.code !== "TENANT_X402_PAYMENT_INVALID") return false;
  return /already.{0,20}used|used.{0,20}(authorization|nonce)|nonce.{0,20}used/i.test(
    failure.x402Error ?? "",
  );
}

function isProvenNoSettlementFailure(failure: UpstreamPaymentFailure): boolean {
  if (failure.code === "payment_insufficient_funds") return true;
  if (failure.code === "TENANT_X402_SETTLEMENT_FAILED") return true;
  return failure.code === "TENANT_X402_PAYMENT_INVALID" && !isAlreadyUsedFailure(failure);
}

export function paymentNetworkUnsupportedError(
  challengeNetworkValues: string[],
  walletNetworkValues: string[],
  extra: Record<string, unknown> = {},
): PaymentBuyerError {
  return new PaymentBuyerError({
    code: "PAYMENT_NETWORK_UNSUPPORTED",
    message: "The x402 challenge does not offer an exact-scheme network and asset supported by this wallet.",
    fundsMoved: false,
    details: {
      challenge_networks: challengeNetworkValues,
      wallet_networks: walletNetworkValues,
      ...extra,
    },
    nextActions: [
      {
        type: "edit_request",
        why: "Use a priced endpoint on one of the wallet networks, or configure a signer for a challenge network.",
      },
    ],
  });
}

function settlementError(
  message: string,
  fundsMoved: false | "unknown",
  details: Record<string, unknown> = {},
  cause?: unknown,
  retryable = false,
  nextActions?: import("../errors.js").NextAction[],
): PaymentBuyerError {
  return new PaymentBuyerError({
    code: "PAYMENT_SETTLEMENT_FAILED",
    message,
    fundsMoved,
    details,
    retryable,
    safeToRetry: fundsMoved === false,
    cause,
    nextActions: nextActions && nextActions.length > 0
      ? nextActions
      : fundsMoved === "unknown"
        ? [
            {
              type: "reconcile_payment",
              safe_to_auto_execute: false,
              why: "Confirm the original settlement before authorizing a different payment proof.",
            },
          ]
        : [
            {
              type: "retry",
              why: "No funds moved; retry after correcting the reported pre-settlement failure.",
            },
          ],
  });
}

function challengeNetworks(response: Response): string[] {
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) return [];
  try {
    const decoded = decodeBase64Json(header) as { accepts?: Array<{ network?: unknown }> };
    return [...new Set((decoded.accepts ?? []).flatMap((accept) =>
      typeof accept.network === "string" ? [accept.network] : [],
    ))];
  } catch {
    return [];
  }
}

async function paymentRequestFingerprint(
  url: string,
  init: RequestInit | undefined,
  maxUsdMicros: number,
  requireReceipt: boolean,
): Promise<string> {
  let request: Request;
  try {
    request = new Request(url, init);
  } catch (cause) {
    throw settlementError("The paid request could not be constructed.", false, {}, cause);
  }
  const headerEntries: Array<[string, string]> = [];
  request.headers.forEach((value, name) => headerEntries.push([name, value]));
  const headers = headerEntries
    .filter(([name]) => ![
      "payment-signature",
      "x-payment",
      "x-run402-payment-attempt-id",
    ].includes(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));
  let bodyHash = "";
  try {
    const body = new Uint8Array(await request.clone().arrayBuffer());
    bodyHash = createHash("sha256").update(body).digest("hex");
  } catch (cause) {
    throw settlementError("The paid request body cannot be replayed safely.", false, {}, cause);
  }
  return createHash("sha256")
    .update(JSON.stringify({
      method: request.method,
      url: request.url,
      headers,
      bodyHash,
      maxUsdMicros,
      requireReceipt,
    }))
    .digest("hex");
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeBase64Json(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Request-scoped payment tracker around `@x402/fetch`.
 *
 * The wrapped package may call its base fetch twice: first without payment to
 * obtain the 402 challenge, then with a signed payment authorization. The
 * AsyncLocalStorage context lets the base-fetch boundary update the correct
 * durable attempt even when multiple paid requests run concurrently.
 *
 * Exported from this module for deterministic boundary tests, but intentionally
 * not re-exported from the package entry point.
 */
export function createTrackedX402Fetch(
  wrapFetchWithPayment: (fetch: FetchFn, client: unknown) => FetchFn,
  client: unknown,
  opts: TrackedPaidFetchOptions = {},
): FetchFn {
  const storage = new AsyncLocalStorage<TrackedPaymentContext>();
  const store = opts.store ?? createFilePaymentAttemptStore();
  const makeId = opts.createAttemptId ?? createPaymentAttemptId;
  const now = opts.now ?? (() => new Date().toISOString());
  const baseFetch: FetchFn = async (input, init) => {
    const context = storage.getStore();
    if (!context) return (opts.fetch ?? globalThis.fetch)(input, init);

    const paymentBearing = hasPaymentAuthorization(input, init);
    if (paymentBearing) {
      ensureIntent(context, store, now);
      context.phase = "payment_submission";
      const startedAt = now();
      writeRecord(context, store, {
        state: "submitting",
        mutation_state: "in_progress",
        provider_started_at: startedAt,
      });
    }

    const [nextInput, nextInit] = withPaymentAttemptHeader(
      input,
      init,
      context.id,
      paymentBearing,
    );
    if (paymentBearing) {
      // This assignment is deliberately immediately before the external call.
      // From this line onward a thrown transport error has an unknown outcome.
      context.providerStarted = true;
    }
    const response = await (opts.fetch ?? globalThis.fetch)(nextInput, nextInit);

    if (!paymentBearing && response.status === 402) {
      context.phase = "challenge_received";
      ensureIntent(context, store, now);
    } else if (paymentBearing) {
      context.phase = "payment_response";
      context.responseStatus = response.status;
      writeRecord(context, store, {
        state: "response_received",
        mutation_state: "in_progress",
        response_status: response.status,
      });
    }
    return response;
  };
  const paidFetch = wrapFetchWithPayment(baseFetch, client);

  return async (input, init) => {
    const suppliedAttemptId = attemptIdFromRequest(input, init);
    const request = requestSummary(input, init);
    if (suppliedAttemptId) {
      let existing: PaymentAttemptRecord | null;
      try {
        existing = store.read(suppliedAttemptId);
      } catch (cause) {
        const code =
          cause instanceof Run402Error && cause.code
            ? cause.code
            : "X402_ATTEMPT_JOURNAL_FAILED";
        throw new PaymentAttemptError({
          code,
          message: "The existing x402 payment attempt could not be inspected; no payment was dispatched.",
          phase: "initial_request",
          paymentAttemptId: suppliedAttemptId,
          providerStarted: false,
          mutationState: "not_started",
          safeToRetry: true,
          retryable: false,
          nextActions: [
            {
              type: "contact_support",
              payment_attempt_id: suppliedAttemptId,
              safe_to_auto_execute: false,
              why: "Preserve and repair the unreadable local payment-attempt record before creating a fresh attempt.",
            },
          ],
          cause,
          request,
        });
      }
      if (existing) {
        throw new PaymentAttemptError({
          code: "X402_ATTEMPT_ID_ALREADY_EXISTS",
          message: "This x402 payment attempt id already exists; reconcile it before authorizing another payment.",
          phase: "payment_response",
          paymentAttemptId: suppliedAttemptId,
          providerStarted: existing.mutation_state !== "not_started",
          responseStatus: existing.response_status ?? null,
          mutationState: existing.mutation_state,
          safeToRetry: false,
          cause: null,
          request,
        });
      }
    }
    const context: TrackedPaymentContext = {
      id: suppliedAttemptId ?? makeId(),
      request,
      createdAt: now(),
      phase: "initial_request",
      providerStarted: false,
      responseStatus: null,
      record: null,
      journalFailure: false,
      now,
    };
    if (suppliedAttemptId) {
      let claimed: boolean;
      try {
        claimed = claimIntent(context, store, now);
      } catch (cause) {
        throw new PaymentAttemptError({
          code: "X402_ATTEMPT_JOURNAL_FAILED",
          message: "The x402 payment attempt id could not be reserved durably; no request was dispatched.",
          phase: "initial_request",
          paymentAttemptId: suppliedAttemptId,
          providerStarted: false,
          mutationState: "not_started",
          safeToRetry: true,
          cause: cause instanceof AttemptJournalWriteError ? cause.cause : cause,
          request,
        });
      }
      if (!claimed) {
        throw new PaymentAttemptError({
          code: "X402_ATTEMPT_ID_ALREADY_EXISTS",
          message: "This x402 payment attempt id was claimed concurrently; reconcile it before authorizing another payment.",
          phase: "initial_request",
          paymentAttemptId: suppliedAttemptId,
          providerStarted: true,
          mutationState: "ambiguous",
          safeToRetry: false,
          cause: null,
          request,
        });
      }
    }
    return storage.run(context, async () => {
      try {
        const response = await paidFetch(input, init);
        if (context.providerStarted) {
          const classification = response.ok
            ? "completed"
            : await opts.classifyPaymentResponse?.(response) ?? "ambiguous";
          const completed = classification === "completed" || classification === "already_settled";
          const failed = classification === "failed";
          const intentPending = classification === "intent_pending";
          const retryAfter = retryAfterSeconds(response);
          writeRecordBestEffort(context, store, {
            state: completed ? "completed" : failed ? "failed" : intentPending ? "intent_pending" : "ambiguous",
            mutation_state: completed ? "completed" : failed ? "not_started" : "ambiguous",
            response_status: response.status,
            ...(intentPending ? {
              last_error_code: "PAYMENT_INTENT_PENDING",
              ...(nonEmptyHeader(response, "x-run402-payment-id")
                ? { payment_id: nonEmptyHeader(response, "x-run402-payment-id")! }
                : {}),
              intent_state: "pending",
              ...(retryAfter !== null ? { retry_after_seconds: retryAfter } : {}),
            } : {}),
          });
          if (intentPending) return response;
          if (!completed && !failed) {
            throw new PaymentAttemptError({
              code: "X402_PAYMENT_OUTCOME_AMBIGUOUS",
              message: "The x402 payment target returned a non-success response after provider dispatch; reconcile the attempt before paying again.",
              phase: "payment_response",
              paymentAttemptId: context.id,
              providerStarted: true,
              responseStatus: response.status,
              mutationState: "ambiguous",
              safeToRetry: false,
              cause: null,
              request: context.request,
            });
          }
        } else if (context.record && context.phase === "initial_request") {
          writeRecordBestEffort(context, store, {
            state: "completed",
            mutation_state: "not_started",
            response_status: response.status,
          });
        }
        return response;
      } catch (cause) {
        const balanceError = cause instanceof X402BalanceError ? cause : unwrapPolicyError(cause);
        if (balanceError) {
          writeRecordBestEffort(context, store, {
            state: "failed",
            mutation_state: "not_started",
            last_error_code: balanceError.code,
          });
          throw balanceError;
        }
        if (cause instanceof PaymentAttemptError) throw cause;
        if (cause instanceof Run402Error && !context.providerStarted) {
          writeRecordBestEffort(context, store, {
            state: "failed",
            mutation_state: "not_started",
            last_error_code: cause.code,
          });
          throw cause;
        }
        const providerStarted = context.providerStarted;
        const journalFailure = cause instanceof AttemptJournalWriteError || context.journalFailure;
        const code = journalFailure
          ? "X402_ATTEMPT_JOURNAL_FAILED"
          : providerStarted
            ? "X402_PAYMENT_OUTCOME_AMBIGUOUS"
            : context.phase === "challenge_received"
              ? "X402_PAYMENT_SIGNING_FAILED"
              : "X402_INITIAL_REQUEST_FAILED";
        const phase = providerStarted
          ? context.responseStatus === null
            ? "payment_submission"
            : "payment_response"
          : context.phase === "challenge_received"
            ? "payment_signing"
            : context.phase;
        const mutationState = providerStarted ? "ambiguous" : "not_started";
        writeRecordBestEffort(context, store, {
          state: providerStarted ? "ambiguous" : "failed",
          mutation_state: mutationState,
          ...(context.responseStatus !== null ? { response_status: context.responseStatus } : {}),
          last_error_code: code,
        });
        throw new PaymentAttemptError({
          code,
          message: providerStarted
            ? "The x402 payment request failed after provider dispatch; its outcome is unknown."
            : journalFailure
              ? "The x402 payment was not dispatched because its durable attempt could not be recorded."
              : phase === "payment_signing"
                ? "The x402 payment authorization could not be created; no payment was dispatched."
                : "The initial request failed before an x402 payment was dispatched.",
          phase,
          paymentAttemptId: context.id,
          providerStarted,
          responseStatus: context.responseStatus,
          mutationState,
          safeToRetry: !providerStarted,
          cause: cause instanceof AttemptJournalWriteError ? cause.cause : cause,
          request: context.request,
        });
      }
    });
  };
}

function ensureIntent(
  context: TrackedPaymentContext,
  store: PaymentAttemptStore,
  now: () => string,
): void {
  if (context.record) return;
  if (!claimIntent(context, store, now)) {
    throw new AttemptJournalWriteError(
      new LocalError(
        "The generated x402 payment attempt id already exists.",
        "reserving x402 payment attempt",
        { code: "X402_ATTEMPT_ID_COLLISION" },
      ),
    );
  }
}

function claimIntent(
  context: TrackedPaymentContext,
  store: PaymentAttemptStore,
  now: () => string,
): boolean {
  if (context.record) return true;
  const updatedAt = now();
  const record: PaymentAttemptRecord = {
    version: 1,
    payment_attempt_id: context.id,
    rail: "x402",
    state: "intent",
    mutation_state: "not_started",
    method: context.request.method,
    origin: context.request.origin,
    path_sha256: context.request.path_sha256,
    ...(context.request.caller_key_sha256
      ? { caller_key_sha256: context.request.caller_key_sha256 }
      : {}),
    created_at: context.createdAt,
    updated_at: updatedAt,
  };
  try {
    const claimed = store.claim(record);
    if (claimed) context.record = record;
    return claimed;
  } catch (cause) {
    context.journalFailure = true;
    throw new AttemptJournalWriteError(cause);
  }
}

function trustedRun402ResponseOrigin(requestUrl: string, response: Response): boolean {
  if (!response.url || response.redirected) return false;
  try {
    const request = new URL(requestUrl);
    const returned = new URL(response.url);
    return request.origin === returned.origin && isTrustedRun402PaymentUrl(request);
  } catch {
    return false;
  }
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function nonEmptyHeader(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim();
  return value ? value : null;
}

function writeRecord(
  context: TrackedPaymentContext,
  store: PaymentAttemptStore,
  patch: Partial<PaymentAttemptRecord>,
): void {
  if (!context.record) throw new AttemptJournalWriteError("payment intent missing");
  const next: PaymentAttemptRecord = {
    ...context.record,
    ...patch,
    updated_at: context.now(),
  };
  try {
    store.write(next);
    context.record = next;
  } catch (cause) {
    context.journalFailure = true;
    throw new AttemptJournalWriteError(cause);
  }
}

function writeRecordBestEffort(
  context: TrackedPaymentContext,
  store: PaymentAttemptStore,
  patch: Partial<PaymentAttemptRecord>,
): void {
  if (!context.record) return;
  try {
    const next: PaymentAttemptRecord = {
      ...context.record,
      ...patch,
      updated_at: context.now(),
    };
    store.write(next);
    context.record = next;
  } catch {
    // The failure already carries the in-process structured outcome. Never
    // replace a known successful response with a local journal write error.
  }
}
