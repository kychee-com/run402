import { test } from "node:test";
import assert from "node:assert/strict";
import { readRemoteStatus } from "./remote-status.js";
test("failed remote reads are unavailable, distinct from a successfully empty tier", async () => {
 const sdk = {tier:{status:async()=>({tier:null})},billing:{checkBalance:async()=>{throw Object.assign(new Error("secret"),{code:"X402_INITIAL_REQUEST_FAILED",category:"network"});}},projects:{list:async()=>({projects:[]})}};
 const result = await readRemoteStatus(sdk as any,"wallet");
 assert.equal(result.availability.tier.state,"available");assert.equal(result.availability.billing.state,"unavailable");assert.equal(result.billing,null);assert.equal(result.next_actions.length,1);assert.doesNotMatch(JSON.stringify(result),/secret/);
});
