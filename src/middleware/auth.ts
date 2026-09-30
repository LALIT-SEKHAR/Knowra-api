import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { User, type UserDocument } from '../models/User.js';
import { resolveWorkspace, type Workspace } from '../services/orgs/workspace.js';

export type AuthPayload = {
  userId: string;
  email: string;
  av?: number;
};

export type AuthedRequest = Request & {
  user?: UserDocument;
  auth?: AuthPayload;
  workspace?: Workspace;
};

export function signToken(payload: AuthPayload, authVersion = 0): string {
  return jwt.sign({ userId: payload.userId, email: payload.email, av: authVersion }, env.JWT_SECRET, {
    expiresIn: '7d',
    algorithm: 'HS256',
  });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as AuthPayload;
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
    const tokenVersion = payload.av ?? 0;
    const currentVersion = user.authVersion ?? 0;
    if (tokenVersion !== currentVersion) {
      throw new AppError('Unauthorized', 401);
    }
    req.auth = payload;
    req.user = user;
    req.workspace = await resolveWorkspace(user);
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
      return;
    }
    next(new AppError('Unauthorized', 401));
  }
}

export function requireManager(req: AuthedRequest, _res: Response, next: NextFunction): void {
  if (!req.workspace?.canManage) {
    next(new AppError('Only an organization admin can do that', 403));
    return;
  }
  next();
}
