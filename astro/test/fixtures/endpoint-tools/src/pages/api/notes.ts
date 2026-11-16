import type { APIRoute } from "astro";

// A static-path endpoint with two handlers and one tool for each. With
// several handlers in the file, every tool states its method.
export const tools = {
  list_notes: {
    method: "GET",
    description: "List the notes, newest first, optionally only those with one tag.",
    input: { type: "object", properties: { tag: { type: "string" } } },
  },
  add_note: {
    method: "POST",
    title: "Add a note",
    description: "Add a note with a title.",
    input: {
      type: "object",
      properties: { title: { type: "string", maxLength: 200 } },
      required: ["title"],
    },
  },
};

const notes: Array<{ id: string; title: string; tag?: string }> = [];

export const GET: APIRoute = ({ url }) => {
  const tag = url.searchParams.get("tag");
  return Response.json(tag ? notes.filter((note) => note.tag === tag) : notes);
};

export const POST: APIRoute = async ({ request }) => {
  const { title } = (await request.json()) as { title: string };
  const note = { id: String(notes.length + 1), title };
  notes.unshift(note);
  return Response.json(note, { status: 201 });
};
