import { email, getRoutedPaymentContext } from "@run402/functions";

const EMAIL_TO = process.env.WALLET_STATS_EMAIL_TO || "major.tal@gmail.com";
const EXPECTED_AMOUNT_USD_MICROS = 30_000;

export default async function walletStats(req) {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const payment = getRoutedPaymentContext(req);
  if (!payment) {
    return Response.json({
      error: "Missing settled x402 payment context",
      expected: "Call this function through the priced /wallet-stats route, not direct /functions/v1.",
    }, { status: 500 });
  }

  const body = await readJson(req);
  const stats = {
    payment_id: payment.paymentId,
    amount_usd_micros: payment.amountUsdMicros,
    amount_usd: usd(payment.amountUsdMicros),
    expected_amount_usd_micros: EXPECTED_AMOUNT_USD_MICROS,
    amount_matches_expected: payment.amountUsdMicros === EXPECTED_AMOUNT_USD_MICROS,
    network: payment.network,
    asset: payment.asset,
    transaction: payment.transaction,
    settled_at: payment.settledAt,
    wallets: {
      payer: {
        address: payment.payer,
        role: "agent payer",
      },
      payout: {
        address: payment.payTo,
        role: "org_default_payout",
      },
    },
    request: {
      request_id: req.headers.get("x-run402-request-id"),
      project_id: req.headers.get("x-run402-project-id"),
      release_id: req.headers.get("x-run402-release-id"),
      host: req.headers.get("host"),
      user_agent: req.headers.get("user-agent"),
    },
    agent: {
      label: stringOrNull(body.agent_label),
      wallet_address: stringOrNull(body.wallet_address),
      note: stringOrNull(body.note),
    },
    observed_at: new Date().toISOString(),
  };

  const mail = await email.send({
    to: EMAIL_TO,
    from_name: "Run402 Wallet Stats Test",
    subject: `Run402 paid wallet stats ${payment.paymentId}`,
    html: renderHtml(stats),
    text: renderText(stats),
  });

  return Response.json({
    ok: true,
    emailed_to: EMAIL_TO,
    email_message_id: mail.message_id ?? mail.id ?? null,
    stats,
  });
}

async function readJson(req) {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return {};
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function usd(amountUsdMicros) {
  return (amountUsdMicros / 1_000_000).toFixed(2);
}

function renderText(stats) {
  return [
    "Run402 tenant x402 wallet stats",
    "",
    `Payment ID: ${stats.payment_id}`,
    `Amount: $${stats.amount_usd} (${stats.amount_usd_micros} micros)`,
    `Amount matches expected: ${stats.amount_matches_expected}`,
    `Network: ${stats.network}`,
    `Asset: ${stats.asset || "unknown"}`,
    `Transaction: ${stats.transaction || "not reported"}`,
    `Settled at: ${stats.settled_at}`,
    "",
    `Agent payer wallet: ${stats.wallets.payer.address || "not reported"}`,
    `Org payout wallet: ${stats.wallets.payout.address}`,
    "",
    `Request ID: ${stats.request.request_id || "unknown"}`,
    `Project ID: ${stats.request.project_id || "unknown"}`,
    `Release ID: ${stats.request.release_id || "unknown"}`,
    `Host: ${stats.request.host || "unknown"}`,
    "",
    `Agent label: ${stats.agent.label || "not supplied"}`,
    `Agent wallet claim: ${stats.agent.wallet_address || "not supplied"}`,
    `Agent note: ${stats.agent.note || "not supplied"}`,
    `Observed at: ${stats.observed_at}`,
  ].join("\n");
}

function renderHtml(stats) {
  const rows = [
    ["Payment ID", stats.payment_id],
    ["Amount", `$${stats.amount_usd} (${stats.amount_usd_micros} micros)`],
    ["Amount matches expected", String(stats.amount_matches_expected)],
    ["Network", stats.network],
    ["Asset", stats.asset || "unknown"],
    ["Transaction", stats.transaction || "not reported"],
    ["Settled at", stats.settled_at],
    ["Agent payer wallet", stats.wallets.payer.address || "not reported"],
    ["Org payout wallet", stats.wallets.payout.address],
    ["Request ID", stats.request.request_id || "unknown"],
    ["Project ID", stats.request.project_id || "unknown"],
    ["Release ID", stats.request.release_id || "unknown"],
    ["Host", stats.request.host || "unknown"],
    ["Agent label", stats.agent.label || "not supplied"],
    ["Agent wallet claim", stats.agent.wallet_address || "not supplied"],
    ["Agent note", stats.agent.note || "not supplied"],
    ["Observed at", stats.observed_at],
  ];
  return [
    "<h1>Run402 tenant x402 wallet stats</h1>",
    "<table>",
    ...rows.map(([label, value]) =>
      `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`),
    "</table>",
  ].join("\n");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
