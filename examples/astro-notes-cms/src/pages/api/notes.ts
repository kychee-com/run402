import type { APIRoute } from 'astro';
import type { ToolDeclarations } from '@run402/functions';
import { addNote, listNotes } from '../../lib/notes';

// The app's MCP tools, declared beside the handlers the site already has.
// Every Run402 app is an MCP server at /_run402/mcp: an assistant the
// signed-in person connected calls `list_notes` and `add_note`, and each call
// is the request below, run as that person (auth.requireUser() and RLS see
// them). `astro build` reads this export by parsing the file, never by running
// it, so every value is a literal. Two handlers in one file: each tool states
// its method. The path is this file's own route, /api/notes.
export const tools = {
  list_notes: {
    method: 'GET',
    description: "List the signed-in person's private notes, oldest first.",
    input: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
  },
  add_note: {
    method: 'POST',
    description: 'Add a private note for the signed-in person.',
    input: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['title'],
    },
  },
} satisfies ToolDeclarations;

const PRIVATE = { 'Cache-Control': 'private, no-store' };

// GET /api/notes?limit=10: a tool call's arguments arrive as the query string.
export const GET: APIRoute = async ({ url }) => {
  const asked = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(asked) && asked >= 1 && asked <= 100 ? asked : undefined;
  return Response.json({ notes: await listNotes(limit) }, { headers: PRIVATE });
};

// POST /api/notes { "title": "…" }: a tool call's arguments arrive as the JSON body.
export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
  if (!(await addNote(body?.title))) {
    return Response.json({ error: 'title must be 1 to 200 characters' }, { status: 400, headers: PRIVATE });
  }
  return Response.json({ added: true }, { status: 201, headers: PRIVATE });
};
