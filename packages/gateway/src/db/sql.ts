/**
 * Branded SQL type — makes SQL strings identifiable and validatable.
 *
 * Usage:
 *   import { sql } from "../db/sql.js";
 *   pool.query(sql(`SELECT * FROM users WHERE id = $1`), [id]);
 *
 * TypeScript enforces that pool.query() only accepts SQL, not raw strings.
 * At test time, all sql() calls are extracted and validated via libpg-query.
 */

declare const __sqlBrand: unique symbol;

/** A string known to be SQL. Only created via sql(). */
export type SQL = string & { readonly [__sqlBrand]: true };

/** Mark a string as SQL. Zero runtime overhead — compiles to identity. */
export function sql(query: string): SQL {
  return query as SQL;
}
