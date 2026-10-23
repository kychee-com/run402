/**
 * Local project-id guard for SDK methods that put a project id into a request
 * path (`/projects/v1/:project_id/...`).
 *
 * A project id is `prj_` followed by URL-safe characters: the hosted gateway
 * mints `prj_<milliseconds>_<slot>`, a self-hosted core runtime `prj_<hex>`.
 * Anything else (an empty value, a SQL string passed where the id belongs, a
 * name, a path) is refused here, before any request, with a code naming the
 * argument and a next action showing the call shape. A value that passes is
 * returned URL-encoded, ready to interpolate.
 */

import { LocalError, type NextAction } from "./errors.js";

/** Every project id format the platform mints, with room to spare. */
export const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9_-]{1,124}$/;

/** True when `value` has the shape of a project id. */
export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

export interface ProjectIdCall {
  /** The SDK method, e.g. `"projects.sql"`. */
  method: string;
  /** The argument's name in that method's signature, e.g. `"id"`. */
  argument: string;
  /** The call shape shown in the next action, e.g. `r.projects.sql("prj_…", sql)`. */
  usage: string;
  /** Short verb phrase identifying the operation (the error's `context`). */
  context: string;
}

/**
 * Describe a rejected value without echoing it: the value may be SQL, a key,
 * or anything else that landed in the wrong argument.
 */
function describeReceived(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value !== "string") return `a ${typeof value}`;
  if (value.length === 0) return "an empty string";
  return /\s/.test(value)
    ? `a ${value.length}-character string containing spaces (it looks like another argument, such as the SQL, landed in the project id's place)`
    : `a ${value.length}-character string that is not a project id`;
}

/**
 * Return `value` URL-encoded for a request path, or throw a `LocalError`
 * with code `BAD_PROJECT_ID` when it is not a project id.
 */
export function projectIdPathSegment(value: unknown, call: ProjectIdCall): string {
  if (isProjectId(value)) return encodeURIComponent(value);
  const nextAction: NextAction = {
    type: "edit_request",
    why: `Pass the project id (prj_…) as \`${call.argument}\`: ${call.usage}. \`run402 projects list\` shows your project ids.`,
  };
  throw new LocalError(
    `${call.method}: \`${call.argument}\` must be a project id (prj_…); got ${describeReceived(value)}.`,
    call.context,
    {
      code: "BAD_PROJECT_ID",
      details: { argument: call.argument, method: call.method, expected_prefix: "prj_" },
      next_actions: [nextAction],
    },
  );
}
