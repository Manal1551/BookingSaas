import { verifyAccessToken, readAccessCookie } from '../utils/tokens.js';
import { HttpError } from '../utils/httpError.js';

/**
 * Verifies the access token and — critically — cross-checks the tenantId in
 * the token against the tenant resolved from the subdomain (req.tenant).
 *
 * A token minted for tenant A, replayed against tenant B's subdomain, is
 * rejected with 403 even though the token's signature is valid. This is the
 * defense against cross-tenant token replay.
 *
 * Must run AFTER resolveTenant.
 */
export function requireAuth(req, res, next) {
  try {
    if (!req.tenant) {
      throw new HttpError(500, 'requireAuth must run after resolveTenant');
    }

    // Prefer httpOnly cookie; allow Authorization: Bearer as a fallback for
    // API clients / scripts.
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null;
    const token = readAccessCookie(req) || bearer;

    if (!token) throw new HttpError(401, 'Not authenticated');

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch {
      throw new HttpError(401, 'Invalid or expired token');
    }

    // The double-check: token tenant must equal subdomain tenant.
    if (String(payload.tenantId) !== String(req.tenant._id)) {
      throw new HttpError(403, 'Token does not belong to this tenant');
    }

    req.user = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Role guard, e.g. requireRole('owner', 'admin'). Runs after requireAuth. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Not authenticated'));
    if (!roles.includes(req.user.role)) {
      return next(new HttpError(403, 'Insufficient role'));
    }
    next();
  };
}
