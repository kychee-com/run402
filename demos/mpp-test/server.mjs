/**
 * Dual-rail payment test server.
 * Accepts BOTH x402 (Base USDC) and MPP (Tempo pathUSD) on the same endpoint.
 */

import express from "express";
import { Mppx, tempo } from "mppx/express";

const PORT = 3402;
const PATH_USD = "0x20c0000000000000000000000000000000000000";
const RECIPIENT = "0x059D091D51a0f011c9872EaA63Df538F5cE15945";
const SECRET_KEY = "test-mpp-secret-key-for-poc";
const AMOUNT = "0.10";

const mppx = Mppx.create({
  methods: [tempo.charge({
    currency: PATH_USD,
    recipient: RECIPIENT,
    testnet: true,
  })],
  secretKey: SECRET_KEY,
});

const app = express();

app.get("/health", (req, res) => {
  res.json({ status: "ok", protocols: ["x402", "mpp"] });
});

// Dual-rail: x402 check first, then MPP
app.get("/premium",
  (req, res, next) => {
    const x402 = req.headers["x-payment"] || req.headers["payment-signature"] || req.headers["x-402-payment"];
    if (x402) {
      // In production: verify on-chain via x402 facilitator
      return res.json({ data: "premium content", paid_via: "x402" });
    }
    next();
  },
  mppx.charge({ amount: AMOUNT }),
  (req, res) => {
    res.json({ data: "premium content", paid_via: "mpp" });
  },
);

app.listen(PORT, () => {
  console.log(`Dual-rail server on http://localhost:${PORT}/premium`);
  console.log(`  MPP:  npx mppx http://localhost:${PORT}/premium`);
  console.log(`  x402: curl -H "x-payment: proof" http://localhost:${PORT}/premium`);
});
