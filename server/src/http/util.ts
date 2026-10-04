import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../lib/logger.js";
import { LaunchError } from "../services/launch.js";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Invalid input",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  if (err instanceof HttpError || err instanceof LaunchError) {
    return res.status(err.status).json({ error: err.message });
  }
  const anyErr = err as { code?: string; message?: string };
  if (anyErr?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image is too large (max 5 MB)" });
  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({ error: "Something went wrong. Please try again." });
}
