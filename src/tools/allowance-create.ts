import { z } from "zod";
import { getAllowancePath } from "../config.js";
import { readAllowance, saveAllowance } from "../allowance.js";
import { randomBytes, createECDH } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const allowanceCreateSchema = {};

export async function handleAllowanceCreate(
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const allowancePath = getAllowancePath();

  const existing = readAllowance();
  if (existing) {
    return {
      content: [
        {
          type: "text",
          text: `Agent allowance already exists at \`${allowancePath}\`.\n\nAddress: \`${existing.address}\`\n\nUse \`allowance_status\` to check details.`,
        },
      ],
      isError: true,
    };
  }

  // Generate private key
  const privateKeyBytes = randomBytes(32);
  const privateKey = `0x${privateKeyBytes.toString("hex")}`;

  // Derive public key using secp256k1
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(privateKeyBytes);
  const uncompressedPubKey = ecdh.getPublicKey();
  // Remove the 04 prefix (uncompressed point marker)
  const pubKeyBody = uncompressedPubKey.subarray(1);

  // Ethereum address = last 20 bytes of keccak256(publicKey)
  const hash = keccak_256(pubKeyBody);
  const addressBytes = hash.slice(-20);
  const address = `0x${Buffer.from(addressBytes).toString("hex")}`;

  // Save allowance using core's atomic write
  saveAllowance({
    address,
    privateKey,
    created: new Date().toISOString(),
    funded: false,
  });

  const lines = [
    `## Agent Allowance Created`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| address | \`${address}\` |`,
    `| saved to | \`${allowancePath}\` |`,
    ``,
    `Use \`request_faucet\` to fund it with testnet USDC, or send USDC on any supported chain.`,
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
