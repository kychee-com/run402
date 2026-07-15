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
import { Run402Error } from "../errors.js";
import { PaidStackUnavailable, loadMppStack, loadX402Stack } from "./_paid-stack.js";

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

export async function setupPaidFetch(): Promise<FetchFn | null> {
  // GH-194: malformed local allowance state remains a local setup concern.
  // No request can be paid without a valid allowance, so callers receive the
  // ordinary unwrapped 402 flow rather than any secret-bearing parse details.
  let allowance;
  try {
    allowance = readAllowance();
  } catch {
    return null;
  }
  if (!allowance) return null;

  try {
    if (allowance.rail === "mpp") {
      const stack = await loadMppStack();
      const account = stack.privateKeyToAccount(allowance.privateKey as `0x${string}`);
      const mppx = stack.Mppx.create({
        polyfill: false,
        methods: [stack.tempo({ account })],
      });
      return mppx.fetch;
    }

    // Default: x402 on Base + Base Sepolia. Each chain has its own independent
    // provider list; one degraded chain does not erase a confirmed balance on
    // the other chain.
    const stack = await loadX402Stack();
    const account = stack.privateKeyToAccount(allowance.privateKey as `0x${string}`);
    const mainnetClients = createRpcClients(stack, stack.base, BASE_RPC_URLS);
    const sepoliaClients = createRpcClients(stack, stack.baseSepolia, BASE_SEPOLIA_RPC_URLS);

    const [mainnet, sepolia] = await Promise.all([
      balanceState(mainnetClients, USDC_MAINNET, allowance.address, "eip155:8453"),
      balanceState(sepoliaClients, USDC_SEPOLIA, allowance.address, "eip155:84532"),
    ]);
    const balances: BalanceStates = {
      "eip155:8453": mainnet,
      "eip155:84532": sepolia,
    };

    const client = new stack.x402Client();
    client.register("eip155:8453", new stack.ExactEvmScheme(stack.toClientEvmSigner(account, mainnetClients[0])));
    client.register("eip155:84532", new stack.ExactEvmScheme(stack.toClientEvmSigner(account, sepoliaClients[0])));
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

    // Read `globalThis.fetch` fresh each call so test suites that swap the
    // global fetch after setupPaidFetch has already run still see their mocks.
    const dynamicFetch: FetchFn = (input, init) => globalThis.fetch(input, init);
    const paidFetch = stack.wrapFetchWithPayment(dynamicFetch, client);
    return async (input, init) => {
      try {
        return await paidFetch(input, init);
      } catch (err) {
        throw unwrapPolicyError(err) ?? err;
      }
    };
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
export function createLazyPaidFetch(): FetchFn {
  return createLazyPaidFetchFrom(setupPaidFetch);
}

/** @internal Source-level unit-test seam; not re-exported by the package. */
export const __paidFetchInternals = {
  createLazyPaidFetchFrom,
};
