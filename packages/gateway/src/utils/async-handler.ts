import { Request, Response, NextFunction } from "express";

/**
 * Wrap an async route handler so thrown errors are forwarded to Express
 * error-handling middleware via next(err) instead of becoming unhandled
 * promise rejections.
 *
 * Usage:
 *   router.get("/path", asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Throw from a route handler to return a specific HTTP status + message.
 * The central error handler in server.ts catches these and responds accordingly.
 *
 * Usage:
 *   throw new HttpError(400, "Invalid input");
 *   throw new HttpError(409, "Already exists");
 */
export class HttpError extends Error {
  public body?: Record<string, unknown>;

  constructor(
    public statusCode: number,
    message: string,
    body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
    this.body = body;
  }
}
