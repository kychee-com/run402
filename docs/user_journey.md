# User Journey — Hello World on Run402

Minimal step-by-step: from zero to a live app with a custom subdomain.

Uses **testnet** (free). All curl commands — no SDK needed.

---

## Step 1: Create a wallet

You need an EVM wallet (private key + address). This happens **outside** the API.

```bash
node -e "
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
const pk = generatePrivateKey();
const acct = privateKeyToAccount(pk);
console.log('PRIVATE_KEY=' + pk);
console.log('WALLET_ADDRESS=' + acct.address);
"
```

Requires: `npm install viem`

Save both values. The private key signs x402 payments. The address is your public identity.

---

## Step 2: Get testnet USDC from the faucet

The faucet gives you 0.25 USDC on Base Sepolia — enough for 2 provisions.

```bash
curl -X POST https://api.run402.com/v1/faucet \
  -H "Content-Type: application/json" \
  -d '{"address": "YOUR_WALLET_ADDRESS"}'
```

Rate limit: 1 drip per IP per 24h.

---

## Step 3: Check pricing (free, no auth)

```bash
curl -X POST https://api.run402.com/v1/projects/quote
```

Returns tiers: prototype ($0.10 / 7 days), hobby ($5 / 30 days), team ($20 / 30 days).

---

## Step 4: Provision a project

This is the first **paid** call. Requires x402 payment signed by your wallet.

You can't do this with plain curl — you need the x402 libraries to sign the payment.

```bash
npm install @x402/fetch@^2 @x402/evm@^2 viem
```

```typescript
// provision.ts
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount("YOUR_PRIVATE_KEY" as `0x${string}`);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const client = new x402Client();
client.register("eip155:84532", new ExactEvmScheme(signer));
const fetchPaid = wrapFetchWithPayment(fetch, client);

const res = await fetchPaid("https://api.run402.com/v1/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "hello-world" }),
});

const project = await res.json();
console.log("PROJECT_ID=" + project.project_id);
console.log("ANON_KEY=" + project.anon_key);
console.log("SERVICE_KEY=" + project.service_key);
```

Run: `npx tsx provision.ts`

Save all three values for the remaining steps.

---

## Step 5: Create a table

Back to plain curl. Use the service_key for admin operations.

```bash
curl -X POST https://api.run402.com/admin/v1/projects/$PROJECT_ID/sql \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: text/plain" \
  -d "CREATE TABLE greetings (
    id serial PRIMARY KEY,
    message text NOT NULL,
    created_at timestamptz DEFAULT now()
  );"
```

---

## Step 6: Insert data

```bash
curl -X POST https://api.run402.com/rest/v1/greetings \
  -H "apikey: $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"message": "Hello from Run402!"}'
```

---

## Step 7: Read data (public)

```bash
curl https://api.run402.com/rest/v1/greetings \
  -H "apikey: $ANON_KEY"
```

---

## Step 8: Deploy a static site

Free with an active tier subscription. Uses wallet auth headers.

```typescript
// deploy-site.ts  (same imports + signer setup as provision.ts)

const res = await fetchPaid("https://api.run402.com/v1/deployments", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "hello-world",
    project: "YOUR_PROJECT_ID",
    files: [
      {
        file: "index.html",
        data: `<!DOCTYPE html>
<html>
<head><title>Hello World</title></head>
<body>
  <h1>Hello World</h1>
  <p>Powered by Run402</p>
  <div id="greetings"></div>
  <script>
    fetch("https://api.run402.com/rest/v1/greetings", {
      headers: { "apikey": "YOUR_ANON_KEY" }
    })
    .then(r => r.json())
    .then(rows => {
      document.getElementById("greetings").innerHTML =
        rows.map(r => "<p>" + r.message + "</p>").join("");
    });
  </script>
</body>
</html>`,
      },
    ],
  }),
});

const deployment = await res.json();
console.log("DEPLOYMENT_ID=" + deployment.id);
console.log("Live at: " + deployment.url);
```

Run: `npx tsx deploy-site.ts`

Your site is now live at the deployment URL (e.g. `https://dpl-xxx.sites.run402.com`).

---

## Step 9: Claim a custom subdomain (free)

Back to curl. Requires service_key.

```bash
curl -X POST https://api.run402.com/v1/subdomains \
  -H "Authorization: Bearer $SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "hello-world", "deployment_id": "YOUR_DEPLOYMENT_ID"}'
```

Your app is now live at **https://hello-world.run402.com**.

---

## What you built

| What | Cost |
|------|------|
| Wallet | Free (local) |
| Testnet USDC | Free (faucet) |
| Tier subscription (prototype) | $0.10 |
| Postgres database | Free (with tier) |
| Static site deployment | Free (with tier) |
| Custom subdomain | Free |
| **Total** | **$0.10 testnet USDC** |

A full-stack app with database, REST API, static site, and custom domain — no signups, no dashboards.
