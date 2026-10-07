export type ErrorCode =
  | "INVALID_PARAM"
  | "OUT_OF_RANGE"
  | "NON_FINITE_RESULT"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "CONFLICT";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function toErrorBody(err: unknown) {
  if (err instanceof ApiError) {
    return { error: { code: err.code, message: err.message, details: err.details ?? null } };
  }
  return {
    error: {
      code: "INTERNAL" as const,
      message: err instanceof Error ? err.message : String(err),
      details: null,
    },
  };
}
