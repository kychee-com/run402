import { getSdk } from "./sdk.mjs";
import { reportSdkError, fail } from "./sdk-errors.mjs";
import {
  assertKnownFlags,
  flagValue,
  hasHelp,
  normalizeArgv,
  positionalArgs,
} from "./argparse.mjs";

const HELP = `run402 pay — Call an x402-priced URL

Usage:
  run402 pay <url> [options]

Options:
  --method <M>              HTTP method (default: GET)
  --body <json-or-text>     Request body (not valid with GET/HEAD)
  --max-usd <amount>        Maximum payment in USD (default: 0.10)
  --idempotency-key <key>   Forward a stable Idempotency-Key to the seller
  --json                    Print the response and payment receipt as JSON
  --help, -h                Show this help

Examples:
  run402 pay https://seller.example/weather
  run402 pay https://seller.example/translate --method POST \
    --body '{"text":"hello"}' --max-usd 0.05 --idempotency-key translation:1

The command uses the same allowance wallet and bounded x402 buyer as the SDK.
An unpriced URL is passed through with payment: null.
On trusted Run402 PAYMENT_INTENT_PENDING, wait for Retry-After and repeat this
identical command with the same payer and --idempotency-key. Never change the key.
`;

const VALUE_FLAGS = ["--method", "--body", "--max-usd", "--idempotency-key"];

export async function run(args = [], deps = {}) {
  if (hasHelp(args)) {
    console.log(HELP);
    return;
  }

  const parsed = normalizeArgv(args);
  assertKnownFlags(parsed, [...VALUE_FLAGS, "--help", "-h"], VALUE_FLAGS);
  const positionals = positionalArgs(parsed, VALUE_FLAGS);
  if (positionals.length !== 1) {
    fail({
      code: "BAD_USAGE",
      message: positionals.length === 0 ? "URL required." : `Unexpected argument: ${positionals[1]}`,
      hint: "run402 pay <url> [--method POST] [--body <value>] [--max-usd 0.10]",
    });
  }

  const url = validateUrl(positionals[0]);
  const method = (flagValue(parsed, "--method") ?? "GET").toUpperCase();
  const body = flagValue(parsed, "--body");
  if (body !== null && (method === "GET" || method === "HEAD")) {
    fail({
      code: "BAD_USAGE",
      message: `--body cannot be used with ${method}`,
      hint: "Pass --method POST, PUT, or PATCH when sending a body.",
    });
  }

  const maxUsd = flagValue(parsed, "--max-usd");
  const idempotencyKey = flagValue(parsed, "--idempotency-key");
  const init = requestInit(method, body);
  const options = {
    ...(maxUsd !== null ? { maxUsdMicros: parseUsdMicros(maxUsd) } : {}),
    ...(idempotencyKey !== null ? { idempotencyKey } : {}),
  };
  const sdk = (deps.getSdk ?? getSdk)();
  const write = deps.write ?? ((value) => console.log(value));

  try {
    const result = await sdk.pay.fetch(url, init, options);
    const responseBody = await readResponseBody(result.response);
    write(JSON.stringify({
      http_status: result.response.status,
      body: responseBody,
      payment: result.payment,
      outcome: result.outcome,
      replay: result.replay,
      payment_id: result.paymentId ?? null,
      deduplicated: result.deduplicated ?? null,
      funds_moved: result.fundsMoved ?? null,
      delivery: result.delivery ?? null,
      settled_at: result.settledAt ?? null,
      intent_state: result.intentState ?? null,
    }));
  } catch (error) {
    (deps.reportSdkError ?? reportSdkError)(error);
  }
}

export function parseUsdMicros(value) {
  const raw = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) {
    fail({
      code: "BAD_FLAG",
      message: `--max-usd must be a non-negative USD amount with at most 6 decimals, got: ${raw}`,
      details: { flag: "--max-usd", value: raw },
    });
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  const micros = whole * 1_000_000 + fraction;
  if (!Number.isSafeInteger(micros)) {
    fail({
      code: "BAD_FLAG",
      message: `--max-usd is too large: ${raw}`,
      details: { flag: "--max-usd", value: raw },
    });
  }
  return micros;
}

function validateUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("unsupported protocol");
    return parsed.toString();
  } catch {
    fail({
      code: "BAD_USAGE",
      message: `Invalid HTTP(S) URL: ${value}`,
      details: { url: value },
    });
  }
}

function requestInit(method, body) {
  if (body === null) return { method };
  const headers = new Headers();
  try {
    JSON.parse(body);
    headers.set("content-type", "application/json");
  } catch {
    headers.set("content-type", "text/plain; charset=utf-8");
  }
  return { method, headers, body };
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  if (response.headers.get("content-type")?.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
