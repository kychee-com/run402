/**
 * Register api.run402.com on x402scan.com
 * Uses SIWX wallet auth with the agentcash wallet.
 */

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const ORIGIN = "https://api.run402.com";
const REGISTER_URL = "https://www.x402scan.com/api/x402/registry/register-origin";

// Load agentcash wallet
const walletPath = `${process.env.HOME}/.agentcash/wallet.json`;
import { readFileSync } from "fs";
const walletData = JSON.parse(readFileSync(walletPath, "utf-8"));

const account = privateKeyToAccount(walletData.privateKey as `0x${string}`);
console.log("Wallet:", account.address);

// Step 1: Get SIWX challenge from x402scan
console.log("\nStep 1: Getting SIWX challenge...");
const challengeRes = await fetch(REGISTER_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ origin: ORIGIN }),
  redirect: "follow",
});

const challengeBody = await challengeRes.json();

if (!challengeBody.extensions?.["sign-in-with-x"]) {
  console.error("No SIWX challenge returned:", JSON.stringify(challengeBody, null, 2));
  process.exit(1);
}

const siwxInfo = challengeBody.extensions["sign-in-with-x"].info;
console.log("Got challenge. Nonce:", siwxInfo.nonce);

// Step 2: Build and sign SIWX message
const siwxMessage = {
  domain: siwxInfo.domain,
  address: account.address,
  statement: siwxInfo.statement,
  uri: siwxInfo.uri,
  version: siwxInfo.version,
  chainId: siwxInfo.chainId,
  type: siwxInfo.type,
  nonce: siwxInfo.nonce,
  issuedAt: siwxInfo.issuedAt,
  expirationTime: siwxInfo.expirationTime,
};

// EIP-191 message format (CAIP-122 / SIWX)
const messageText = [
  `${siwxMessage.domain} wants you to sign in with your Ethereum account:`,
  siwxMessage.address,
  "",
  siwxMessage.statement,
  "",
  `URI: ${siwxMessage.uri}`,
  `Version: ${siwxMessage.version}`,
  `Chain ID: ${siwxMessage.chainId.split(":")[1]}`,
  `Nonce: ${siwxMessage.nonce}`,
  `Issued At: ${siwxMessage.issuedAt}`,
  `Expiration Time: ${siwxMessage.expirationTime}`,
].join("\n");

console.log("\nSigning message...");
const signature = await account.signMessage({ message: messageText });

const signedSiwx = { ...siwxMessage, signature };
const siwxHeader = Buffer.from(JSON.stringify(signedSiwx)).toString("base64");

// Step 3: Send authenticated request
console.log("\nStep 3: Registering on x402scan...");
const registerRes = await fetch(REGISTER_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "SIGN-IN-WITH-X": siwxHeader,
  },
  body: JSON.stringify({ origin: ORIGIN }),
  redirect: "follow",
});

const result = await registerRes.json();
console.log("\nResult:", JSON.stringify(result, null, 2));

if (result.failedDetails && result.failedDetails.length > 0) {
  console.log("\nFailed endpoints:");
  for (const f of result.failedDetails) {
    console.log(`  ${f.method} ${f.path}: ${f.reason}`);
  }
}
