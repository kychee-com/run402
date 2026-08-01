import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

import { LocalError } from "../errors.js";
import {
  APPROVED_ALBY_HUB_COMMIT,
  APPROVED_LIGHTNING_WALLET_PROVIDER,
  albyHubProviderFeeCeilingMsat,
  type LightningWalletAdapter,
  type LightningWalletNetwork,
  type LightningWalletPaymentResult,
  type PreparedLightningWalletPayment,
} from "./lightning-wallet-adapter.js";

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;

type NostrEvent = Record<"created_at", number> & {
  id: string;
  pubkey: string;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

interface ParsedNwcConnection {
  relay: string;
  walletPubkey: string;
  clientSecret: string;
}

export interface NwcRpcTransport {
  prepare(method: string, params: Record<string, unknown>): PreparedNwcRequest;
  execute(request: PreparedNwcRequest): Promise<NwcRpcResponse>;
}

export interface PreparedNwcRequest {
  id: string;
  method: string;
  event: unknown;
}

export interface NwcRpcResponse {
  requestId: string;
  responseEventId: string;
  resultType: string | null;
  result: Record<string, unknown> | null;
  error: { code: string | null; message: string | null } | null;
}

export interface AlbyHubLndNwcAdapterOptions {
  alias: `nwc:${string}`;
  connectionUri?: string;
  connectionProvider?: () => Promise<string>;
  payeeNodePubkeys: readonly string[];
  network: LightningWalletNetwork;
  transport?: NwcRpcTransport;
  timeoutMs?: number;
}

export class AlbyHubLndNwcAdapter implements LightningWalletAdapter {
  readonly provider = APPROVED_LIGHTNING_WALLET_PROVIDER;
  readonly providerCommit = APPROVED_ALBY_HUB_COMMIT;
  readonly backend = "lnd" as const;
  readonly feePolicy = "max_1pct_or_10000msat" as const;
  readonly network: LightningWalletNetwork;
  readonly atomicFeeCap = true as const;
  readonly alias: `nwc:${string}`;
  readonly payeeNodePubkeys: readonly string[];
  private transportPromise: Promise<NwcRpcTransport> | null = null;

  constructor(private readonly options: AlbyHubLndNwcAdapterOptions) {
    if (!/^nwc:[a-z0-9][a-z0-9_-]{0,63}$/.test(options.alias)) {
      throw lightningPaymentError("LIGHTNING_WALLET_ALIAS_INVALID");
    }
    if (options.payeeNodePubkeys.length === 0 || options.payeeNodePubkeys.some(
      (key) => !/^(02|03)[0-9a-f]{64}$/i.test(key),
    )) {
      throw lightningPaymentError("LIGHTNING_PAYEE_SET_INVALID");
    }
    if (options.network !== "regtest" && options.network !== "mainnet") {
      throw lightningPaymentError("LIGHTNING_NETWORK_INVALID");
    }
    if (!options.transport && !options.connectionUri && !options.connectionProvider) {
      throw lightningPaymentError("LIGHTNING_WALLET_CONNECTION_REQUIRED");
    }
    this.alias = options.alias;
    this.network = options.network;
    this.payeeNodePubkeys = [...options.payeeNodePubkeys].map((key) => key.toLowerCase());
  }

  async preparePayment(input: {
    invoice: string;
    paymentHash: string;
    invoiceAmountMsat: number;
    authorizedMaxFeeMsat: number;
  }): Promise<PreparedLightningWalletPayment> {
    if (!HEX_32.test(input.paymentHash) || !Number.isSafeInteger(input.authorizedMaxFeeMsat) ||
        input.authorizedMaxFeeMsat < 0) {
      throw lightningPaymentError("LIGHTNING_PAYMENT_INPUT_INVALID");
    }
    const providerFeeCeilingMsat = albyHubProviderFeeCeilingMsat(input.invoiceAmountMsat);
    if (input.authorizedMaxFeeMsat < providerFeeCeilingMsat) {
      throw lightningPaymentError("PAYMENT_WALLET_FEE_CAP_UNSUPPORTED");
    }
    const transport = await this.transport();
    const prepared = transport.prepare("pay_invoice", { invoice: input.invoice });
    return {
      walletRequestId: prepared.id,
      providerFeeCeilingMsat,
      dispatch: async () => {
        const paid = await transport.execute(prepared);
        if (paid.error) {
          return {
            state: "unknown",
            paymentHash: input.paymentHash,
            walletRequestId: prepared.id,
            invoiceAmountMsat: input.invoiceAmountMsat,
            feesPaidMsat: null,
            totalDebitMsat: null,
            providerReference: paid.responseEventId,
            failureCode: paid.error.code,
          };
        }
        const immediatePreimage = stringField(paid.result, "preimage");
        const recovered = await this.lookupPayment({
          paymentHash: input.paymentHash,
          walletRequestId: prepared.id,
        });
        if (recovered.state === "settled" && !recovered.preimageHex && immediatePreimage &&
            HEX_32.test(immediatePreimage.toLowerCase())) {
          return { ...recovered, preimageHex: immediatePreimage.toLowerCase() };
        }
        return recovered;
      },
    };
  }

  async lookupPayment(input: {
    paymentHash: string;
    walletRequestId?: string | null;
  }): Promise<LightningWalletPaymentResult> {
    if (!HEX_32.test(input.paymentHash)) {
      throw lightningPaymentError("LIGHTNING_PAYMENT_HASH_INVALID");
    }
    const transport = await this.transport();
    const prepared = transport.prepare("lookup_invoice", { payment_hash: input.paymentHash });
    let response: NwcRpcResponse;
    try {
      response = await transport.execute(prepared);
    } catch {
      return unknownResult(input.paymentHash, input.walletRequestId ?? null, "NWC_LOOKUP_UNAVAILABLE");
    }
    if (response.error) {
      return unknownResult(
        input.paymentHash,
        input.walletRequestId ?? null,
        response.error.code ?? "NWC_LOOKUP_FAILED",
        response.responseEventId,
      );
    }
    return paymentResultFromLookup(
      response.result,
      input.paymentHash,
      input.walletRequestId ?? null,
      response.responseEventId,
    );
  }

  private async transport(): Promise<NwcRpcTransport> {
    if (this.options.transport) return this.options.transport;
    this.transportPromise ??= (async () => {
      const uri = this.options.connectionUri ?? await this.options.connectionProvider!();
      return new NostrNwcRpcTransport(uri, this.options.timeoutMs);
    })();
    return this.transportPromise;
  }
}

export class NostrNwcRpcTransport implements NwcRpcTransport {
  private readonly connection: ParsedNwcConnection;
  private readonly timeoutMs: number;

  constructor(connectionUri: string, timeoutMs = 30_000) {
    this.connection = parseNwcConnection(connectionUri);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw lightningPaymentError("NWC_TIMEOUT_INVALID");
    }
    this.timeoutMs = timeoutMs;
  }

  prepare(method: string, params: Record<string, unknown>): PreparedNwcRequest {
    if (!/^[a-z_]{1,64}$/.test(method)) throw lightningPaymentError("NWC_METHOD_INVALID");
    const content = encryptNip04(
      JSON.stringify({ method, params }),
      this.connection.clientSecret,
      this.connection.walletPubkey,
    );
    const event = signEvent({
      kind: 23_194,
      created_at: Math.floor(Date.now() / 1_000),
      tags: [["p", this.connection.walletPubkey], ["encryption", "nip04"]],
      content,
    }, this.connection.clientSecret);
    return { id: event.id, method, event };
  }

  async execute(request: PreparedNwcRequest): Promise<NwcRpcResponse> {
    const event = request.event as NostrEvent;
    if (event.id !== request.id || !verifyEvent(event)) {
      throw lightningPaymentError("NWC_REQUEST_INVALID");
    }
    const responseEvent = await relayRequest(
      this.connection.relay,
      this.connection.walletPubkey,
      event,
      this.timeoutMs,
    );
    if (!verifyEvent(responseEvent) || responseEvent.pubkey !== this.connection.walletPubkey ||
        responseEvent.kind !== 23_195 ||
        !responseEvent.tags.some((tag) => tag[0] === "e" && tag[1] === request.id)) {
      throw lightningPaymentError("NWC_RESPONSE_INVALID");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(decryptNip04(
        responseEvent.content,
        this.connection.clientSecret,
        this.connection.walletPubkey,
      ));
    } catch {
      throw lightningPaymentError("NWC_RESPONSE_INVALID");
    }
    const body = record(decoded);
    const resultType = typeof body.result_type === "string" ? body.result_type : null;
    const errorBody = recordOrNull(body.error);
    return {
      requestId: request.id,
      responseEventId: responseEvent.id,
      resultType,
      result: recordOrNull(body.result),
      error: errorBody ? {
        code: typeof errorBody.code === "string" ? errorBody.code : null,
        message: typeof errorBody.message === "string" ? errorBody.message : null,
      } : null,
    };
  }
}

function parseNwcConnection(value: string): ParsedNwcConnection {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw lightningPaymentError("NWC_CONNECTION_INVALID");
  }
  if (!new Set(["nostr+walletconnect:", "nostrwalletconnect:"]).has(url.protocol)) {
    throw lightningPaymentError("NWC_CONNECTION_INVALID");
  }
  const walletPubkey = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
  const clientSecret = (url.searchParams.get("secret") ?? "").toLowerCase();
  const relay = url.searchParams.get("relay") ?? "";
  if (!HEX_32.test(walletPubkey) || !HEX_32.test(clientSecret)) {
    throw lightningPaymentError("NWC_CONNECTION_INVALID");
  }
  let relayUrl: URL;
  try {
    relayUrl = new URL(relay);
  } catch {
    throw lightningPaymentError("NWC_CONNECTION_INVALID");
  }
  if (relayUrl.protocol !== "wss:" && relayUrl.protocol !== "ws:") {
    throw lightningPaymentError("NWC_CONNECTION_INVALID");
  }
  return { relay: relayUrl.toString(), walletPubkey, clientSecret };
}

function sharedSecret(privateKeyHex: string, publicKeyHex: string): Buffer {
  const compressedPublicKey = Buffer.concat([Buffer.from([2]), Buffer.from(publicKeyHex, "hex")]);
  return Buffer.from(
    secp256k1.getSharedSecret(hexToBytes(privateKeyHex), compressedPublicKey),
  ).subarray(1, 33);
}

function encryptNip04(plaintext: string, privateKeyHex: string, publicKeyHex: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", sharedSecret(privateKeyHex, publicKeyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${ciphertext.toString("base64")}?iv=${iv.toString("base64")}`;
}

function decryptNip04(payload: string, privateKeyHex: string, publicKeyHex: string): string {
  const separator = payload.indexOf("?iv=");
  if (separator <= 0) throw lightningPaymentError("NWC_RESPONSE_INVALID");
  const ciphertext = Buffer.from(payload.slice(0, separator), "base64");
  const iv = Buffer.from(payload.slice(separator + 4), "base64");
  if (iv.length !== 16 || ciphertext.length === 0) {
    throw lightningPaymentError("NWC_RESPONSE_INVALID");
  }
  const decipher = createDecipheriv("aes-256-cbc", sharedSecret(privateKeyHex, publicKeyHex), iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function signEvent(
  template: Pick<NostrEvent, "kind" | "created_at" | "tags" | "content">,
  privateKeyHex: string,
): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(privateKeyHex)));
  const serialized = JSON.stringify([
    0, pubkey, template.created_at, template.kind, template.tags, template.content,
  ]);
  const id = bytesToHex(sha256(utf8ToBytes(serialized)));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(privateKeyHex)));
  return { ...template, pubkey, id, sig };
}

function verifyEvent(event: NostrEvent): boolean {
  if (!HEX_32.test(event.id) || !HEX_32.test(event.pubkey) || !HEX_64.test(event.sig) ||
      !Number.isSafeInteger(event.created_at) || !Number.isSafeInteger(event.kind) ||
      !Array.isArray(event.tags) || typeof event.content !== "string") return false;
  const serialized = JSON.stringify([
    0, event.pubkey, event.created_at, event.kind, event.tags, event.content,
  ]);
  const expectedId = bytesToHex(sha256(utf8ToBytes(serialized)));
  return expectedId === event.id && schnorr.verify(
    hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey),
  );
}

async function relayRequest(
  relay: string,
  walletPubkey: string,
  event: NostrEvent,
  timeoutMs: number,
): Promise<NostrEvent> {
  const socket = new WebSocket(relay);
  const subscriptionId = `run402-${event.id.slice(0, 16)}`;
  return new Promise<NostrEvent>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: NostrEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.send(JSON.stringify(["CLOSE", subscriptionId])); } catch { /* closed */ }
      socket.close();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(() => finish(lightningPaymentError("NWC_RESPONSE_TIMEOUT")), timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify([
        "REQ", subscriptionId,
        { kinds: [23_195], authors: [walletPubkey], "#e": [event.id] },
      ]));
      socket.send(JSON.stringify(["EVENT", event]));
    }, { once: true });
    socket.addEventListener("message", (message) => {
      try {
        const parsed = JSON.parse(String(message.data));
        if (Array.isArray(parsed) && parsed[0] === "EVENT" && parsed[1] === subscriptionId) {
          finish(undefined, parsed[2] as NostrEvent);
        }
      } catch {
        finish(lightningPaymentError("NWC_RESPONSE_INVALID"));
      }
    });
    socket.addEventListener("error", () => finish(
      lightningPaymentError("NWC_RELAY_UNAVAILABLE"),
    ), { once: true });
  });
}

function paymentResultFromLookup(
  value: Record<string, unknown> | null,
  expectedPaymentHash: string,
  walletRequestId: string | null,
  providerReference: string,
): LightningWalletPaymentResult {
  if (!value) return unknownResult(expectedPaymentHash, walletRequestId, "NWC_LOOKUP_INVALID", providerReference);
  const paymentHash = (stringField(value, "payment_hash") ?? expectedPaymentHash).toLowerCase();
  const preimageHex = stringField(value, "preimage")?.toLowerCase();
  if (paymentHash !== expectedPaymentHash || (preimageHex && !HEX_32.test(preimageHex))) {
    return unknownResult(expectedPaymentHash, walletRequestId, "NWC_LOOKUP_MISMATCH", providerReference);
  }
  if (!preimageHex) return unknownResult(expectedPaymentHash, walletRequestId, "NWC_PAYMENT_UNRESOLVED", providerReference);
  const derived = createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex");
  if (derived !== expectedPaymentHash) {
    return unknownResult(expectedPaymentHash, walletRequestId, "NWC_PREIMAGE_HASH_MISMATCH", providerReference);
  }
  const invoiceAmountMsat = integerField(value, ["amount", "amount_msat", "amount_paid_msat"]);
  const feesPaidMsat = integerField(value, ["fees_paid", "fees_paid_msat"]);
  if (invoiceAmountMsat === null || feesPaidMsat === null) {
    return unknownResult(expectedPaymentHash, walletRequestId, "NWC_FINAL_DEBIT_MISSING", providerReference);
  }
  const totalDebitMsat = invoiceAmountMsat + feesPaidMsat;
  if (!Number.isSafeInteger(totalDebitMsat)) {
    return unknownResult(expectedPaymentHash, walletRequestId, "NWC_FINAL_DEBIT_INVALID", providerReference);
  }
  return {
    state: "settled",
    paymentHash,
    walletRequestId,
    invoiceAmountMsat,
    feesPaidMsat,
    totalDebitMsat,
    preimageHex,
    providerReference,
    failureCode: null,
  };
}

function unknownResult(
  paymentHash: string,
  walletRequestId: string | null,
  failureCode: string,
  providerReference: string | null = null,
): LightningWalletPaymentResult {
  return {
    state: "unknown",
    paymentHash,
    walletRequestId,
    invoiceAmountMsat: null,
    feesPaidMsat: null,
    totalDebitMsat: null,
    providerReference,
    failureCode,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw lightningPaymentError("NWC_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function stringField(value: Record<string, unknown> | null, field: string): string | null {
  const item = value?.[field];
  return typeof item === "string" && item.length > 0 ? item : null;
}

function integerField(value: Record<string, unknown>, fields: readonly string[]): number | null {
  for (const field of fields) {
    const item = value[field];
    const parsed = typeof item === "number" ? item :
      typeof item === "string" && /^\d+$/.test(item) ? Number(item) : NaN;
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function lightningPaymentError(code: string): LocalError {
  return new LocalError(code, "using Lightning payment wallet", { code });
}
