import { auth, db } from '@run402/functions';

/** The signed-in person's notes, oldest first. RLS selects the actor's rows: no privileged client, no redundant user filter. */
export async function listNotes(limit?: number) {
  await auth.requireUser();
  const notes = db().from('private_notes').select('id,title').order('id');
  return limit === undefined ? notes : notes.limit(limit);
}

/** Add a note for the signed-in person. False, with nothing written, when the title is empty or over 200 characters. */
export async function addNote(title: unknown): Promise<boolean> {
  const actor = await auth.requireUser();
  const clean = String(title ?? '').trim();
  if (!clean || clean.length > 200) return false;
  await db().from('private_notes').insert({ title: clean, user_id: actor.id });
  return true;
}

export async function notesForRequest(request: Request) {
  await auth.requireUser();
  if (request.method === 'POST') {
    const form = await request.formData();
    if (!(await addNote(form.get('title')))) return { invalid: true, rows: [] };
  }
  return { invalid: false, rows: await listNotes() };
}
