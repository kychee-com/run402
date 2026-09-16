import { ApiError, isRun402Error, type Run402Error } from "./errors.js";

/** Client diagnostic only: the original PostgREST body/status remain available. */
export class RestPermissionDenied extends ApiError {
  override readonly code = "REST_PERMISSION_DENIED";
  override readonly details: { source: "postgrest"; upstream_status: number | null; upstream_code: "42501"; method: string; relation: string };
  constructor(error: Run402Error, method: string, relation: string) {
    super("PostgREST denied this operation; check grants and policies for the request role.", error.status, error.body, error.context);
    this.details = { source: "postgrest", upstream_status: error.status, upstream_code: "42501", method, relation };
  }
}

export function restDiagnostic(error: unknown, method: string, relation: string): unknown {
  if (!isRun402Error(error)) return error;
  const body = error.body as { code?: unknown } | null;
  // Only the public native SQLSTATE is interpreted. Never parse private schema
  // names out of upstream text or infer exposure/RLS from permission denial.
  return body?.code === "42501" ? new RestPermissionDenied(error, method, relation) : error;
}
