import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { verifyToken, type AuthUserPayload } from '../auth/authService';
import { resolveSalesReadPropertyScope } from './bookingSalesDetailService';

type RequestWithUser = Request & { user?: AuthUserPayload };

function sendAuthError(res: Response, statusCode: number, code: string, error: string): void {
  res.status(statusCode).json({
    success: false,
    code,
    error,
  });
}

/**
 * Authenticated, property-scoped read context for Penjualan/transaction GETs.
 * Reuses req.user when operationalAccessGuard already verified the token.
 * Invalid or missing Bearer tokens fail closed with 401.
 */
export async function resolveAuthenticatedTransactionRead(params: {
  req: Request;
  res: Response;
  pool: Pool;
}): Promise<{ propertyId: number; user: AuthUserPayload } | null> {
  const req = params.req as RequestWithUser;
  let user = req.user && Number.isInteger(Number(req.user.id)) ? req.user : null;

  if (!user) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      sendAuthError(
        params.res,
        401,
        'UNAUTHORIZED',
        'Akses ditolak. Silakan login terlebih dahulu.'
      );
      return null;
    }
    try {
      user = verifyToken(authHeader.split(' ')[1]);
      req.user = user;
    } catch {
      sendAuthError(
        params.res,
        401,
        'INVALID_TOKEN',
        'Sesi login telah kedaluwarsa atau token tidak valid. Silakan login kembali.'
      );
      return null;
    }
  }

  try {
    const scoped = await resolveSalesReadPropertyScope({
      pool: params.pool,
      userId: Number(user.id),
      tokenPropertyId: user.property_id,
      requestedPropertyId: req.query.property_id ?? (req as any).propertyId,
    });
    return { propertyId: scoped.propertyId, user };
  } catch (err: any) {
    params.res.status(err.statusCode || 500).json({
      success: false,
      code: err.code || 'FORBIDDEN',
      error: err.message,
    });
    return null;
  }
}
