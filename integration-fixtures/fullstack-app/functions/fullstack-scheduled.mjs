import { adminDb } from "@run402/functions";

function rowsFromSql(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

export default async function handler() {
  const rows = rowsFromSql(await adminDb().sql(`
    INSERT INTO fs_runtime_events (kind, actor, details)
    VALUES ('scheduled-manual', 'scheduler', '{"manual":true}'::jsonb)
    RETURNING id, kind, actor, details, created_at
  `));
  return Response.json({ ok: true, scheduled: true, rows });
}
