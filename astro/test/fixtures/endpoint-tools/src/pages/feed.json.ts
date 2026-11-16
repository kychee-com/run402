import type { APIRoute } from "astro";

// A prerendered endpoint: Astro writes `feed.json` at build and a static file
// answers the path, so a tool call would never reach this handler. Declaring
// a tool here fails the build with MCP_TOOL_ROUTE_ELSEWHERE.
export const prerender = true;

export const tool = {
  name: "read_feed",
  description: "Read the feed.",
  input: { type: "object", properties: {} },
};

export const GET: APIRoute = () => Response.json({ items: [] });
