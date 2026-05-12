const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey",
};

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }
  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "method_not_allowed", method: req.method },
      { status: 405, headers: JSON_HEADERS },
    );
  }

  const body = await readJson(req);
  const url = new URL(req.url);
  return Response.json(
    {
      ok: true,
      route: "fullstack-public",
      method: req.method,
      path: url.pathname,
      marker: body.marker ?? "RUN402_FULLSTACK_PUBLIC_ROUTE_MARKER",
    },
    { headers: JSON_HEADERS },
  );
}
