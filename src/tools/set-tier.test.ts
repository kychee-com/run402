import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RUN402_MPP_LIGHTNING_PROFILE } from "../../sdk/dist/index.js";
import { handleSetTier, setTierSchema } from "./set-tier.js";

describe("set_tier payment parity", () => {
  it("exposes the shared preference, profile, key, evidence, and cap inputs", () => {
    assert.deepEqual(Object.keys(setTierSchema).sort(), [
      "evidence_policy", "idempotency_key", "max_native_amount_msat",
      "max_routing_fee_msat", "max_usd_micros", "organization_id",
      "payment_preferences", "profile", "tier",
    ]);
  });

  it("forwards a Lightning tier call to the existing SDK helper without another workflow", async () => {
    let captured: unknown;
    const body = {
      wallet: "wallet", action: "subscribe", tier: "prototype", previous_tier: null,
      lease_started_at: "2026-07-31T12:00:00.000Z",
      lease_expires_at: "2026-08-07T12:00:00.000Z",
      allowance_remaining_usd_micros: 0,
      payment_result: { protocol: "mpp", method: "lightning", intent: "charge" },
    };
    const result = await handleSetTier({
      tier: "prototype",
      idempotency_key: "tier:lightning:1",
      payment_preferences: [{
        protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot",
      }],
      profile: RUN402_MPP_LIGHTNING_PROFILE,
      max_usd_micros: 100_000,
      max_native_amount_msat: 1_100_000,
      max_routing_fee_msat: 10_000,
      evidence_policy: "run402_settlement",
      organization_id: "org_1",
    }, {
      getSdk: (() => ({
        tier: {
          async set(tier: string, options: unknown) {
            captured = { tier, options };
            return body;
          },
        },
      })) as never,
    });
    assert.deepEqual(captured, {
      tier: "prototype",
      options: {
        idempotencyKey: "tier:lightning:1",
        paymentPreferences: [{
          protocol: "mpp", method: "lightning", intent: "charge", wallet: "nwc:deploy-bot",
        }],
        profile: RUN402_MPP_LIGHTNING_PROFILE,
        maxUsdMicros: 100_000,
        maxNativeAmountMsat: 1_100_000,
        maxRoutingFeeMsat: 10_000,
        evidencePolicy: "run402_settlement",
        organizationId: "org_1",
        principalTransport: "siwx",
      },
    });
    assert.deepEqual(result.structuredContent, body);
  });
});
