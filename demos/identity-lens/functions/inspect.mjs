function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default async function inspectIdentity(request) {
  if (request.method !== "GET") {
    return json({
      error: "Method not allowed",
      code: "METHOD_NOT_ALLOWED",
    }, 405);
  }

  const headers = request.headers;
  return json({
    observed_at: new Date().toISOString(),
    transport: "public_run402_route",
    request_metadata: {
      method: request.method,
      user_agent_visible: headers.has("user-agent"),
      accept_language_visible: headers.has("accept-language"),
      request_id: headers.get("x-run402-request-id"),
    },
    identity_visibility: {
      run402_agent_principal: null,
      run402_human_principal: null,
      tenant_actor: null,
      buzz_nostr_identity: null,
      x402_payer: null,
    },
    explanation: "This public, unpriced route receives ordinary request metadata. Run402 control-plane and Buzz identities are not injected into tenant traffic.",
  });
}
