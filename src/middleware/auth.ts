import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { User, type UserDocument } from '../models/User.js';

export type AuthPayload = {
  userId: string;
  email: string;
};

export type AuthedRequest = Request & {
  user?: UserDocument;
  auth?: AuthPayload;
};

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, env.JWT_SECRET) as AuthPayload;
}

export async function requireAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('Unauthorized', 401);
    }
    const token = header.slice(7);
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId);
    if (!user) {
      throw new AppError('Unauthorized', 401);
    }
    req.auth = payload;
    req.user = user;
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    next(new AppError('Unauthorized', 401));
  }
}
