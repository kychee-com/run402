/**
 * Strip SQL string literals so blocked-pattern regexes don't match inside quoted content.
 *
 * Handles:
 *  - Single-quoted strings: 'hello ''world'''  →  ''
 *  - Dollar-quoted strings: $$body$$ or $tag$body$tag$  →  $$$$  or $tag$$tag$
 *  - Escaped single quotes inside strings ('' is the SQL escape for ')
 *
 * Does NOT handle:
 *  - E'...' strings with C-style escapes (rare in user migrations)
 *  - Nested dollar-quoting with identical tags (invalid SQL anyway)
 */
export function stripSqlStrings(sql: string): string {
  // Replace dollar-quoted strings first (they can contain single quotes)
  // Matches $tag$...$tag$ where tag is optional (empty = $$...$$)
  let result = sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, (match, tag) => {
    return `$${tag}$$${tag}$`;
  });

  // Replace single-quoted strings (handling '' escape sequences)
  result = result.replace(/'(?:[^']|'')*'/g, "''");

  return result;
}

/**
 * SQL statement blocklist patterns — defense-in-depth.
 * (Real boundary is search_path + pre_request hook.)
 */
export const BLOCKED_SQL_PATTERNS: Array<{ pattern: RegExp; hint?: string }> = [
  { pattern: /\bCREATE\s+EXTENSION\b/i },
  { pattern: /\bCOPY\b.*\bPROGRAM\b/i },
  { pattern: /\bALTER\s+SYSTEM\b/i },
  { pattern: /\bSET\s+search_path\b/i },
  { pattern: /\bCREATE\s+SCHEMA\b/i },
  { pattern: /\bDROP\s+SCHEMA\b/i },
  {
    pattern: /\bGRANT\b/i,
    hint: "Permissions are managed automatically. For SERIAL/BIGSERIAL columns, sequence permissions are pre-granted. Prefer BIGINT GENERATED ALWAYS AS IDENTITY over SERIAL for new tables.",
  },
  {
    pattern: /\bREVOKE\b/i,
    hint: "Permissions are managed automatically. Use RLS policies (POST /projects/v1/admin/:id/rls) to control row-level access.",
  },
  { pattern: /\bCREATE\s+ROLE\b/i },
  { pattern: /\bDROP\s+ROLE\b/i },
];

/**
 * Check SQL for blocked patterns, ignoring content inside string literals.
 * Returns an error object if blocked, null if safe.
 */
export function checkSqlSafety(sql: string): { error: string; hint?: string } | null {
  const stripped = stripSqlStrings(sql);
  for (const { pattern, hint } of BLOCKED_SQL_PATTERNS) {
    if (pattern.test(stripped)) {
      return {
        error: `Blocked SQL pattern: ${pattern.source}`,
        hint,
      };
    }
  }
  return null;
}
