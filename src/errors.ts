export type ErrorCode =
  | "VALIDATION_ERROR"
  | "RANGE_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BAD_REQUEST"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 400,
  ) {
    super(message);
  }
}

export const validationError = (msg: string): ApiError => new ApiError("VALIDATION_ERROR", msg, 400);
export const rangeError = (msg: string): ApiError => new ApiError("RANGE_ERROR", msg, 422);
export const notFound = (msg: string): ApiError => new ApiError("NOT_FOUND", msg, 404);
