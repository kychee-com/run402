import type { APIRoute } from "astro";

// A dynamic endpoint with one handler: its single `tool` states a name, takes
// the file's one handler as its method, and `[note_id]` becomes `{note_id}`,
// a required property of `input`.
export const tool = {
  name: "update_note",
  description: "Replace the text of one note.",
  input: {
    type: "object",
    properties: { note_id: { type: "string" }, text: { type: "string" } },
    required: ["note_id", "text"],
  },
};

export const POST: APIRoute = async ({ params, request }) => {
  const { text } = (await request.json()) as { text: string };
  return Response.json({ id: params.note_id, text });
};
