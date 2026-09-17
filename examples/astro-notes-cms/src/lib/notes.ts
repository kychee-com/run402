import { auth, db } from '@run402/functions';
export async function notesForRequest(request: Request) {
  const actor = await auth.requireUser();
  if (request.method === 'POST') {
    const form = await request.formData();
    const title = String(form.get('title') ?? '').trim();
    if (!title || title.length > 200) return { invalid: true, rows: [] };
    await db().from('private_notes').insert({ title, user_id: actor.id });
  }
  // RLS selects the actor's rows. No privileged client or redundant user filter.
  const rows = await db().from('private_notes').select('id,title').order('id');
  return { invalid: false, rows };
}
