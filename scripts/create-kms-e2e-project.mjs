import { privateKeyToAccount } from "viem/accounts";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const pk = readFileSync("c:/Workspace-Kychee/bld402/showcase/.wallet","utf-8").trim();
const account = privateKeyToAccount(pk);
const API = "https://api.run402.com";

async function siwx(uri, statement) {
  const payload = await createSIWxPayload({
    domain: "api.run402.com", uri, statement, version: "1",
    nonce: randomBytes(16).toString("hex"),
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 5*60*1000).toISOString(),
    chainId: "eip155:84532", type: "eip191",
  }, account);
  return encodeSIWxHeader(payload);
}

async function post(path, body, statement){
  const h = await siwx(`${API}${path}`, statement);
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "SIGN-IN-WITH-X": h },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, body: t };
}

// 1. Subscribe to prototype tier (should be free)
let r = await post("/tiers/v1/prototype", {}, "Subscribe prototype tier");
console.log("tier:", r.status, r.body.slice(0,200));
// 2. Create project
r = await post("/projects/v1", { name: "kms-e2e-closeout" }, "Create kms-e2e project");
console.log("project:", r.status, r.body);
