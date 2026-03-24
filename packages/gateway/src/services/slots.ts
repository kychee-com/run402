import { pool } from "../db/pool.js";
import { sql } from "../db/sql.js";
import { MAX_SCHEMA_SLOTS } from "../config.js";
import { hasCode } from "../utils/errors.js";

/**
 * Initialize the slot sequence from database state.
 * Creates the sequence if it doesn't exist, and advances it past all
 * currently allocated slots.
 */
export async function initSlots(): Promise<void> {
  const client = await pool.connect();
  try {
    // Create sequence if it doesn't exist (idempotent for existing deployments)
    await client.query(
      sql(`CREATE SEQUENCE IF NOT EXISTS internal.slot_seq MAXVALUE ${MAX_SCHEMA_SLOTS} NO CYCLE`),
    );

    // Advance the sequence past all existing slots so it never collides.
    // Find the highest slot number across ALL projects (any status).
    const result = await client.query(
      sql(`SELECT max(replace(schema_slot, 'p', '')::int) AS max_slot FROM internal.projects`),
    );
    const maxSlot = result.rows[0]?.max_slot;
    if (maxSlot != null) {
      await client.query(sql(`SELECT setval('internal.slot_seq', $1)`), [maxSlot]);
    }

    const cur = await client.query(sql(`SELECT last_value FROM internal.slot_seq`));
    console.log(`  Slot allocator initialized: sequence at ${cur.rows[0].last_value}`);
  } finally {
    client.release();
  }
}

/**
 * Allocate the next available schema slot.
 * First tries to reuse an archived/deleted slot (atomic), then draws
 * from the sequence (atomic). No in-memory state — fully concurrency-safe.
 */
export async function allocateSlot(): Promise<string | null> {
  // Try to reuse an archived/deleted slot (atomic: single DELETE ... RETURNING)
  const reuse = await pool.query(
    sql(`DELETE FROM internal.projects
     WHERE id = (
       SELECT id FROM internal.projects
       WHERE status IN ('archived', 'deleted')
       ORDER BY schema_slot ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING schema_slot`),
  );

  if (reuse.rows.length > 0) {
    return reuse.rows[0].schema_slot;
  }

  // Allocate a new slot from the sequence
  try {
    const result = await pool.query(sql(`SELECT nextval('internal.slot_seq')::int AS n`));
    return `p${String(result.rows[0].n).padStart(4, "0")}`;
  } catch (err: unknown) {
    // Sequence exhausted (reached MAXVALUE with NO CYCLE)
    if (hasCode(err) && err.code === "55000") {
      return null;
    }
    throw err;
  }
}
