import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getActiveProfile, getConfigDir } from "../../core-dist/config.js";
import { LocalError } from "../errors.js";
import { AlbyHubLndNwcAdapter, NostrNwcRpcTransport } from "./alby-hub-nwc-adapter.js";
import {
  APPROVED_ALBY_HUB_COMMIT,
  APPROVED_LIGHTNING_WALLET_PROVIDER,
  type LightningWalletAdapter,
  type LightningWalletNetwork,
} from "./lightning-wallet-adapter.js";

const STORE_VERSION = 1;
const SERVICE = "com.run402.lightning.nwc";
const MAX_COMMAND_OUTPUT_BYTES = 65_536;

export interface LightningInstrumentMetadata {
  alias: `nwc:${string}`;
  provider: typeof APPROVED_LIGHTNING_WALLET_PROVIDER;
  provider_commit: typeof APPROVED_ALBY_HUB_COMMIT;
  backend: "lnd";
  network: LightningWalletNetwork;
  payee_node_pubkeys: string[];
  created_at: string;
}

interface LightningInstrumentFile {
  version: typeof STORE_VERSION;
  instruments: LightningInstrumentMetadata[];
}

export interface LightningInstrumentSecretStore {
  put(account: string, value: string): Promise<void>;
  get(account: string): Promise<string>;
  delete(account: string): Promise<void>;
}

export interface LightningInstrumentStoreOptions {
  metadataPath?: string;
  profile?: string;
  secretStore?: LightningInstrumentSecretStore;
}

export class OsLightningInstrumentSecretStore implements LightningInstrumentSecretStore {
  constructor(private readonly platform = process.platform) {}

  async put(account: string, value: string): Promise<void> {
    if (this.platform === "darwin") {
      await runCredentialCommand(
        "/usr/bin/security",
        ["add-generic-password", "-a", account, "-s", SERVICE, "-U", "-w"],
        `${value}\n`,
      );
      return;
    }
    if (this.platform === "linux") {
      await runCredentialCommand(
        "secret-tool",
        ["store", `--label=Run402 Lightning ${account}`, "service", SERVICE, "account", account],
        value,
      );
      return;
    }
    throw lightningInstrumentError("LIGHTNING_CREDENTIAL_STORE_UNAVAILABLE");
  }

  async get(account: string): Promise<string> {
    const output = this.platform === "darwin"
      ? await runCredentialCommand(
          "/usr/bin/security",
          ["find-generic-password", "-a", account, "-s", SERVICE, "-w"],
        )
      : this.platform === "linux"
        ? await runCredentialCommand(
            "secret-tool",
            ["lookup", "service", SERVICE, "account", account],
          )
        : null;
    if (output === null) throw lightningInstrumentError("LIGHTNING_CREDENTIAL_STORE_UNAVAILABLE");
    const value = output.trim();
    if (!value) throw lightningInstrumentError("LIGHTNING_INSTRUMENT_NOT_FOUND");
    return value;
  }

  async delete(account: string): Promise<void> {
    if (this.platform === "darwin") {
      await runCredentialCommand(
        "/usr/bin/security",
        ["delete-generic-password", "-a", account, "-s", SERVICE],
      );
      return;
    }
    if (this.platform === "linux") {
      await runCredentialCommand(
        "secret-tool",
        ["clear", "service", SERVICE, "account", account],
      );
      return;
    }
    throw lightningInstrumentError("LIGHTNING_CREDENTIAL_STORE_UNAVAILABLE");
  }
}

export function lightningInstrumentMetadataPath(): string {
  return join(getConfigDir(), "lightning-instruments.v1.json");
}

export function listConfiguredLightningInstruments(
  options: LightningInstrumentStoreOptions = {},
): LightningInstrumentMetadata[] {
  return readInstrumentFile(options.metadataPath).instruments;
}

export function loadConfiguredLightningWallets(
  options: LightningInstrumentStoreOptions = {},
): LightningWalletAdapter[] {
  const secretStore = options.secretStore ?? new OsLightningInstrumentSecretStore();
  const profile = options.profile ?? getActiveProfile();
  return listConfiguredLightningInstruments(options).map((instrument) =>
    new AlbyHubLndNwcAdapter({
      alias: instrument.alias,
      network: instrument.network,
      payeeNodePubkeys: instrument.payee_node_pubkeys,
      connectionProvider: () => secretStore.get(secretAccount(profile, instrument.alias)),
    }));
}

export async function addConfiguredLightningInstrument(input: {
  alias: `nwc:${string}`;
  connectionUri: string;
  network: LightningWalletNetwork;
  payeeNodePubkeys: readonly string[];
}, options: LightningInstrumentStoreOptions = {}): Promise<LightningInstrumentMetadata> {
  // Constructing the transport validates the URI without retaining it in metadata.
  new NostrNwcRpcTransport(input.connectionUri);
  const adapter = new AlbyHubLndNwcAdapter({
    alias: input.alias,
    connectionUri: input.connectionUri,
    network: input.network,
    payeeNodePubkeys: input.payeeNodePubkeys,
  });
  const secretStore = options.secretStore ?? new OsLightningInstrumentSecretStore();
  const profile = options.profile ?? getActiveProfile();
  const path = options.metadataPath ?? lightningInstrumentMetadataPath();
  const current = readInstrumentFile(path);
  if (current.instruments.some((item) => item.alias === adapter.alias)) {
    throw lightningInstrumentError("LIGHTNING_INSTRUMENT_EXISTS");
  }
  const metadata: LightningInstrumentMetadata = {
    alias: adapter.alias,
    provider: APPROVED_LIGHTNING_WALLET_PROVIDER,
    provider_commit: APPROVED_ALBY_HUB_COMMIT,
    backend: "lnd",
    network: adapter.network,
    payee_node_pubkeys: [...adapter.payeeNodePubkeys],
    created_at: new Date().toISOString(),
  };
  const account = secretAccount(profile, adapter.alias);
  await secretStore.put(account, input.connectionUri);
  try {
    writeInstrumentFile(path, {
      version: STORE_VERSION,
      instruments: [...current.instruments, metadata],
    });
  } catch (error) {
    await secretStore.delete(account).catch(() => {});
    throw error;
  }
  return metadata;
}

export async function removeConfiguredLightningInstrument(
  alias: `nwc:${string}`,
  options: LightningInstrumentStoreOptions = {},
): Promise<boolean> {
  const path = options.metadataPath ?? lightningInstrumentMetadataPath();
  const current = readInstrumentFile(path);
  const retained = current.instruments.filter((item) => item.alias !== alias);
  if (retained.length === current.instruments.length) return false;
  const secretStore = options.secretStore ?? new OsLightningInstrumentSecretStore();
  const profile = options.profile ?? getActiveProfile();
  await secretStore.delete(secretAccount(profile, alias));
  writeInstrumentFile(path, { version: STORE_VERSION, instruments: retained });
  return true;
}

function readInstrumentFile(path = lightningInstrumentMetadataPath()): LightningInstrumentFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
    if (code === "ENOENT") return { version: STORE_VERSION, instruments: [] };
    throw lightningInstrumentError("LIGHTNING_INSTRUMENT_METADATA_INVALID", error);
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
  if (record?.version !== STORE_VERSION || !Array.isArray(record.instruments)) {
    throw lightningInstrumentError("LIGHTNING_INSTRUMENT_METADATA_INVALID");
  }
  const instruments = record.instruments.map(validateMetadata);
  if (new Set(instruments.map((item) => item.alias)).size !== instruments.length) {
    throw lightningInstrumentError("LIGHTNING_INSTRUMENT_METADATA_INVALID");
  }
  return { version: STORE_VERSION, instruments };
}

function validateMetadata(value: unknown): LightningInstrumentMetadata {
  const item = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const payees = item?.payee_node_pubkeys;
  if (!item || typeof item.alias !== "string" || !/^nwc:[a-z0-9][a-z0-9_-]{0,63}$/.test(item.alias) ||
      item.provider !== APPROVED_LIGHTNING_WALLET_PROVIDER ||
      item.provider_commit !== APPROVED_ALBY_HUB_COMMIT || item.backend !== "lnd" ||
      (item.network !== "regtest" && item.network !== "mainnet") ||
      !Array.isArray(payees) || payees.length === 0 ||
      payees.some((key) => typeof key !== "string" || !/^(02|03)[0-9a-f]{64}$/i.test(key)) ||
      typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at))) {
    throw lightningInstrumentError("LIGHTNING_INSTRUMENT_METADATA_INVALID");
  }
  return {
    alias: item.alias as `nwc:${string}`,
    provider: APPROVED_LIGHTNING_WALLET_PROVIDER,
    provider_commit: APPROVED_ALBY_HUB_COMMIT,
    backend: "lnd",
    network: item.network,
    payee_node_pubkeys: (payees as string[]).map((key) => key.toLowerCase()),
    created_at: item.created_at,
  };
}

function writeInstrumentFile(path: string, value: LightningInstrumentFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.lightning-instruments.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* best effort on non-POSIX */ }
}

function secretAccount(profile: string, alias: string): string {
  return `${profile}:${alias}`;
}

function runCredentialCommand(
  command: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= MAX_COMMAND_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once("error", (cause) => reject(
      lightningInstrumentError("LIGHTNING_CREDENTIAL_STORE_UNAVAILABLE", cause),
    ));
    child.once("close", (code) => {
      if (code !== 0 || outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        reject(lightningInstrumentError("LIGHTNING_CREDENTIAL_STORE_FAILED"));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function lightningInstrumentError(code: string, cause?: unknown): LocalError {
  return new LocalError(code, "managing Lightning payment instrument", { code, cause });
}
