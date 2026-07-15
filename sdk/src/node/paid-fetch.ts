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
  /** Refreshes mutable balance state without re-resolving the selected payer. */
  refreshBalances(): Promise<void>;
};

export type LazyPaidFetch = FetchFn & {
  /** Initializes the selected source if needed and returns public payer provenance only. */
  getPayer(): Promise<PaymentPayerProvenance | null>;
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
  request: { method: string; origin: string | null; path: string | null };
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
): ConfiguredPaidFetch {
  return Object.assign(fetchFn, { payer, refreshBalances });
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
    const context: TrackedPaymentContext = {
      id: attemptIdFromRequest(input, init) ?? makeId(),
      request: requestSummary(input, init),
      createdAt: now(),
      phase: "initial_request",
      providerStarted: false,
      responseStatus: null,
      record: null,
      journalFailure: false,
      now,
    };
    return storage.run(context, async () => {
      try {
        const response = await paidFetch(input, init);
        if (context.providerStarted) {
          const completed = response.ok;
          writeRecordBestEffort(context, store, {
            state: completed ? "completed" : "ambiguous",
            mutation_state: completed ? "completed" : "ambiguous",
            response_status: response.status,
          });
        }
        return response;
      } catch (cause) {
        const balanceError = cause instanceof X402BalanceError ? cause : unwrapPolicyError(cause);
        if (balanceError) throw balanceError;
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
  const updatedAt = now();
  const record: PaymentAttemptRecord = {
    version: 1,
    payment_attempt_id: context.id,
    rail: "x402",
    state: "intent",
    mutation_state: "not_started",
    method: context.request.method,
    origin: context.request.origin,
    path: context.request.path,
    created_at: context.createdAt,
    updated_at: updatedAt,
  };
  try {
    store.write(record);
    context.record = record;
  } catch (cause) {
    context.journalFailure = true;
    throw new AttemptJournalWriteError(cause);
  }
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
