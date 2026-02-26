import { pool } from "../db/pool.js";
import { MAX_SCHEMA_SLOTS } from "../config.js";

let nextSlot = 1;

/**
 * Initialize slot counter from database state.
 * Finds the highest allocated slot and starts from the next one.
 */
export async function initSlots(): Promise<void> {
  const result = await pool.query(
    `SELECT schema_slot FROM internal.projects WHERE status = 'active' ORDER BY schema_slot DESC LIMIT 1`,
  );
  if (result.rows.length > 0) {
    const slotNum = parseInt(result.rows[0].schema_slot.replace("p", ""), 10);
    nextSlot = slotNum + 1;
  }
  console.log(`  Slot allocator initialized: next slot = p${String(nextSlot).padStart(4, "0")}`);
}

/**
 * Allocate the next available schema slot.
 * First tries to reuse an archived slot, then allocates a new one.
 */
export async function allocateSlot(): Promise<string | null> {
  // Try to find an archived/deleted slot to reuse
  const reuse = await pool.query(
    `SELECT schema_slot FROM internal.projects
     WHERE status IN ('archived', 'deleted')
     ORDER BY schema_slot ASC LIMIT 1`,
  );

  if (reuse.rows.length > 0) {
    const slot = reuse.rows[0].schema_slot;
    // Remove the old record so the slot can be reused
    await pool.query(
      `DELETE FROM internal.projects WHERE schema_slot = $1 AND status IN ('archived', 'deleted')`,
      [slot],
    );
    return slot;
  }

  // Allocate new slot
  if (nextSlot > MAX_SCHEMA_SLOTS) {
    return null; // No slots available
  }

  const slot = `p${String(nextSlot).padStart(4, "0")}`;
  nextSlot++;
  return slot;
}

export function getNextSlotNumber(): number {
  return nextSlot;
}
