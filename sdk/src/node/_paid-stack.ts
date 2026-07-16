/**
 * Single audit surface for the optional paid-fetch dependency stack.
 *
 * Every `viem` / `@x402/*` / `mppx` import the SDK performs flows through
 * this file. Concentrating the imports here lets a reviewer enumerate the
 * SDK's direct attack surface to those packages from one place, and lets
 * the package.json declare them as `optionalPeerDependencies` — consumers
 * who never make on-chain paid requests do not need to install them.
 *
 * Adding a new import here is the only way to grow the surface; doing so
 * also widens what consumers must install to enable paid fetch. Keep this
 * list minimal. When a symbol is small enough to inline (e.g. the
 * `viem/chains` constants are ~5-line objects), prefer inlining over
 * adding a new dependency edge.
 */

type FetchFn = typeof globalThis.fetch;

export class PaidStackUnavailable extends Error {
  readonly missingPackages: readonly string[];
  constructor(missing: readonly string[]) {
    super(
      `run402: paid requests require optional peer dependencies that are not installed: ${missing.join(", ")}. ` +
        `Install them with: npm install ${missing.join(" ")}`,
    );
    this.name = "PaidStackUnavailable";
    this.missingPackages = missing;
  }
}

function isModuleNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  return /Cannot find (package|module)/.test(err.message);
}

class LoadCollector {
  readonly missing = new Set<string>();
  firstOtherError: unknown = null;

  async load<T>(pkg: string, load: () => Promise<T>): Promise<T | undefined> {
    try {
      return await load();
    } catch (err) {
      if (isModuleNotFound(err)) this.missing.add(pkg);
      else if (this.firstOtherError === null) this.firstOtherError = err;
      return undefined;
    }
  }

  throwIfFailed(): void {
    if (this.missing.size > 0) {
      throw new PaidStackUnavailable([...this.missing].sort());
    }
    if (this.firstOtherError !== null) throw this.firstOtherError;
  }
}

export interface X402Stack {
  privateKeyToAccount: (pk: `0x${string}`) => unknown;
  createPublicClient: (opts: unknown) => { readContract: (args: unknown) => Promise<bigint> };
  http: (url?: string) => unknown;
  base: unknown;
  baseSepolia: unknown;
  x402Client: new () => {
    register: (network: string, scheme: unknown) => void;
    registerPolicy: (fn: (version: number, reqs: unknown[]) => unknown[]) => void;
  };
  wrapFetchWithPayment: (fetch: FetchFn, client: unknown) => FetchFn;
  ExactEvmScheme: new (signer: unknown) => unknown;
  toClientEvmSigner: (account: unknown, client: unknown) => unknown;
}

export interface MppStack {
  privateKeyToAccount: (pk: `0x${string}`) => unknown;
  Mppx: { create: (opts: unknown) => { fetch: FetchFn } };
  tempo: (opts: unknown) => unknown;
}

export async function loadX402Stack(): Promise<X402Stack> {
  const c = new LoadCollector();
  const accounts = await c.load("viem", () => import("viem/accounts"));
  const viemMod = await c.load("viem", () => import("viem"));
  const chains = await c.load("viem", () => import("viem/chains"));
  const x402Fetch = await c.load("@x402/fetch", () => import("@x402/fetch"));
  const x402EvmClient = await c.load("@x402/evm", () => import("@x402/evm/exact/client"));
  const x402Evm = await c.load("@x402/evm", () => import("@x402/evm"));
  c.throwIfFailed();
  return {
    privateKeyToAccount: accounts!.privateKeyToAccount as (pk: `0x${string}`) => unknown,
    createPublicClient: viemMod!.createPublicClient as never,
    http: viemMod!.http as never,
    base: chains!.base,
    baseSepolia: chains!.baseSepolia,
    x402Client: x402Fetch!.x402Client as never,
    wrapFetchWithPayment: x402Fetch!.wrapFetchWithPayment as never,
    ExactEvmScheme: x402EvmClient!.ExactEvmScheme as never,
    toClientEvmSigner: x402Evm!.toClientEvmSigner as never,
  };
}

export async function loadMppStack(): Promise<MppStack> {
  const c = new LoadCollector();
  const mppxSpecifier = "mppx/client";
  const mppx = await c.load("mppx", () =>
    import(/* webpackIgnore: true */ mppxSpecifier) as Promise<{
      Mppx: { create: (opts: unknown) => { fetch: FetchFn } };
      tempo: (opts: unknown) => unknown;
    }>,
  );
  const accounts = await c.load("viem", () => import("viem/accounts"));
  c.throwIfFailed();
  return {
    privateKeyToAccount: accounts!.privateKeyToAccount as (pk: `0x${string}`) => unknown,
    Mppx: mppx!.Mppx,
    tempo: mppx!.tempo,
  };
}
