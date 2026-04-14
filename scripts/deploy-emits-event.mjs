// Deploy a minimal EmitsEvent contract on Base Sepolia for kms-wallet-contracts E2E (task §15.2).
// Uses agentdb/faucet-treasury-key as deployer.
//
// EmitsEvent:
//   event Ping(address indexed caller, uint256 nonce);
//   function ping(uint256 n) external { emit Ping(msg.sender, n); }

import { execSync } from "node:child_process";
import { createWalletClient, createPublicClient, http, parseAbi, encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const pk = execSync(
  'aws secretsmanager get-secret-value --secret-id agentdb/faucet-treasury-key --query SecretString --output text --region us-east-1 --profile kychee',
  { encoding: "utf-8" }
).trim();

const account = privateKeyToAccount(pk);
console.log("Deployer:", account.address);

// Bytecode from:
// pragma solidity ^0.8.20;
// contract EmitsEvent {
//   event Ping(address indexed caller, uint256 nonce);
//   function ping(uint256 n) external { emit Ping(msg.sender, n); }
// }
// Compiled with solc 0.8.24 --optimize --optimize-runs 200.
const BYTECODE = "0x6080604052348015600f57600080fd5b5060b380601d6000396000f3fe6080604052348015600f57600080fd5b506004361060285760003560e01c8063f1723df914602d575b600080fd5b603c60383660046050565b603e565b005b60405181815233907f8c9e8f35ef9c47c86dfed15aa93c0cefbfa6b39e9c0b0a0d7d21ea64d0e6f27b9060200160405180910390a250565b600060208284031215606157600080fd5b503591905056fea264697066735822122000000000000000000000000000000000000000000000000000000000000000006c634300081800";

const ABI = parseAbi([
  "event Ping(address indexed caller, uint256 nonce)",
  "function ping(uint256 n)",
]);

const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

const deployData = encodeDeployData({ abi: ABI, bytecode: BYTECODE, args: [] });
const hash = await wallet.sendTransaction({ to: null, data: deployData });
console.log("tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log("contract:", receipt.contractAddress);
console.log("block:", receipt.blockNumber, "gas:", receipt.gasUsed);
