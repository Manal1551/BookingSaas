import jwt from 'jsonwebtoken';
import { env, isProd } from '../config/env.js';

/**
 * JWT payload shape: { userId, tenantId, role }
 * Access + refresh are signed with DIFFERENT secrets so one can never be used
 * as the other.
 */

export function signAccessToken({ userId, tenantId, role }) {
  return jwt.sign(
    { userId: String(userId), tenantId: String(tenantId), role },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES }
  );
}

export function signRefreshToken({ userId, tenantId, role }) {
  return jwt.sign(
    { userId: String(userId), tenantId: String(tenantId), role },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
}

// --- Cookie helpers: tokens live in httpOnly cookies, not localStorage. ---
const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

const baseCookieOpts = {
  httpOnly: true,
  secure: isProd, // over HTTPS in prod; http allowed for local dev
  sameSite: 'lax',
  path: '/',
};

// ~15m and ~7d in ms — coarse, just for cookie maxAge.
const ACCESS_MAX_AGE = 15 * 60 * 1000;
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseCookieOpts,
    maxAge: ACCESS_MAX_AGE,
  });
  // Refresh cookie is restricted to the refresh endpoint path.
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookieOpts,
    path: '/api/auth/refresh',
    maxAge: REFRESH_MAX_AGE,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookieOpts });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookieOpts, path: '/api/auth/refresh' });
}

export function readAccessCookie(req) {
  return req.cookies?.[ACCESS_COOKIE];
}

export function readRefreshCookie(req) {
  return req.cookies?.[REFRESH_COOKIE];
}
