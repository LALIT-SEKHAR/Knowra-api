import type { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  statusCode: number;
  expose: boolean;
  details?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode = 500,
    exposeOrDetails: boolean | Record<string, unknown> = true,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    if (typeof exposeOrDetails === 'boolean') {
      this.expose = exposeOrDetails;
      this.details = details;
    } else {
      this.expose = true;
      this.details = exposeOrDetails;
    }
  }
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.expose ? err.message : 'Something went wrong',
      ...(err.details ?? {}),
    });
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
