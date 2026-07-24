import bcrypt from 'bcrypt';
import { z } from 'zod';
import { User } from '../models/User.js';
import { HttpError, asyncHandler } from '../utils/httpError.js';
import {
  signAccessToken,
  signRefreshToken,
  setAuthCookies,
  clearAuthCookies,
  verifyRefreshToken,
  readRefreshCookie,
} from '../utils/tokens.js';

const BCRYPT_ROUNDS = 12;

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'password must be at least 8 characters').max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function issueTokens(res, user, tenant) {
  const claims = { userId: user._id, tenantId: tenant._id, role: user.role };
  const accessToken = signAccessToken(claims);
  const refreshToken = signRefreshToken(claims);
  setAuthCookies(res, { accessToken, refreshToken });
  return { accessToken, refreshToken };
}

function publicUser(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

// POST /api/auth/register  (tenant-scoped: runs behind resolveTenant)
export const register = asyncHandler(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  }
  const { name, email, password } = parsed.data;
  const tenant = req.tenant;

  // tenantScopePlugin scopes this to the current tenant automatically.
  const existing = await User.findOne({ email: email.toLowerCase() }).lean();
  if (existing) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // First user of a tenant becomes owner; subsequent users are members.
  const isFirst = (await User.countDocuments()) === 0;
  const user = await User.create({
    name,
    email: email.toLowerCase(),
    passwordHash,
    role: isFirst ? 'owner' : 'member',
  });

  issueTokens(res, user, tenant);
  res.status(201).json({ user: publicUser(user), tenant: publicTenant(tenant) });
});

// POST /api/auth/login  (tenant-scoped)
export const login = asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  }
  const { email, password } = parsed.data;
  const tenant = req.tenant;

  // Need passwordHash which is select:false by default.
  const user = await User.findOne({ email: email.toLowerCase() }).select(
    '+passwordHash'
  );
  // Same generic error whether the user is missing or the password is wrong.
  if (!user) throw new HttpError(401, 'Invalid email or password');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'Invalid email or password');

  issueTokens(res, user, tenant);
  res.json({ user: publicUser(user), tenant: publicTenant(tenant) });
});

// POST /api/auth/refresh  (tenant-scoped: subdomain still checked)
export const refresh = asyncHandler(async (req, res) => {
  const token = readRefreshCookie(req);
  if (!token) throw new HttpError(401, 'No refresh token');

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new HttpError(401, 'Invalid or expired refresh token');
  }

  // Same cross-tenant replay defense as requireAuth.
  if (String(payload.tenantId) !== String(req.tenant._id)) {
    throw new HttpError(403, 'Refresh token does not belong to this tenant');
  }

  // Confirm the user still exists in this tenant.
  const user = await User.findById(payload.userId);
  if (!user) throw new HttpError(401, 'User no longer exists');

  issueTokens(res, user, req.tenant);
  res.json({ user: publicUser(user), tenant: publicTenant(req.tenant) });
});

// GET /api/auth/me  (protected)
export const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.userId);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user: publicUser(user), tenant: publicTenant(req.tenant) });
});

// POST /api/auth/logout
export const logout = asyncHandler(async (_req, res) => {
  clearAuthCookies(res);
  res.json({ ok: true });
});

function publicTenant(tenant) {
  return {
    id: tenant._id,
    name: tenant.name,
    slug: tenant.slug,
    plan: tenant.plan,
  };
}
