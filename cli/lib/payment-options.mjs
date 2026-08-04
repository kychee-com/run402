import { fail } from "./sdk-errors.mjs";
import { flagValue, parseIntegerFlag } from "./argparse.mjs";

export const PAYMENT_VALUE_FLAGS = [
  "--payment-preferences",
  "--payment-profile",
  "--max-native-msat",
  "--max-routing-fee-msat",
  "--evidence-policy",
];

export function paymentOptionsFromFlags(parsed) {
  const preferencesRaw = flagValue(parsed, "--payment-preferences");
  const profile = flagValue(parsed, "--payment-profile");
  const maxNative = flagValue(parsed, "--max-native-msat");
  const maxRoutingFee = flagValue(parsed, "--max-routing-fee-msat");
  const evidencePolicy = flagValue(parsed, "--evidence-policy");
  let paymentPreferences;
  if (preferencesRaw !== null) {
    try {
      paymentPreferences = JSON.parse(preferencesRaw);
    } catch {
      fail({
        code: "BAD_FLAG",
        message: "--payment-preferences must be a JSON array.",
        details: { flag: "--payment-preferences" },
      });
    }
    if (!Array.isArray(paymentPreferences)) {
      fail({
        code: "BAD_FLAG",
        message: "--payment-preferences must be a JSON array.",
        details: { flag: "--payment-preferences" },
      });
    }
  }
  if (evidencePolicy !== null && ![
    "none", "protocol_settlement", "run402_settlement", "merchant_fulfillment",
  ].includes(evidencePolicy)) {
    fail({
      code: "BAD_FLAG",
      message: "--evidence-policy must be none, protocol_settlement, run402_settlement, or merchant_fulfillment.",
      details: { flag: "--evidence-policy", value: evidencePolicy },
    });
  }
  return {
    ...(paymentPreferences ? { paymentPreferences } : {}),
    ...(profile !== null ? { profile } : {}),
    ...(maxNative !== null
      ? { maxNativeAmountMsat: parseIntegerFlag("--max-native-msat", maxNative, { min: 0 }) }
      : {}),
    ...(maxRoutingFee !== null
      ? { maxRoutingFeeMsat: parseIntegerFlag("--max-routing-fee-msat", maxRoutingFee, { min: 0 }) }
      : {}),
    ...(evidencePolicy !== null ? { evidencePolicy } : {}),
  };
}
