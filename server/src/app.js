import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { env } from './config/env.js';
import { buildOriginMatcher } from './utils/corsOrigin.js';
import authRoutes from './routes/auth.routes.js';
import tenantRoutes from './routes/tenant.routes.js';
import bookingRoutes from './routes/booking.routes.js';
import billingRoutes from './routes/billing.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Behind a proxy in prod (needed for secure cookies + correct req.hostname).
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: buildOriginMatcher(env.CLIENT_ORIGIN_PATTERN, env.ROOT_DOMAIN),
      credentials: true, // allow httpOnly cookies cross-subdomain
    })
  );
  /**
   * Stripe webhooks are mounted BEFORE `express.json()` — deliberately, and
   * this ordering is load-bearing.
   *
   * Signature verification hashes the exact bytes Stripe sent. Once
   * `express.json()` consumes the stream, the original buffer is gone and only
   * a parsed object remains; re-serialising it produces different bytes and
   * every event would be rejected as forged. The webhook router therefore
   * claims this path first with `express.raw()` and hands the untouched Buffer
   * to the verifier.
   *
   * It also sits ahead of CORS-sensitive and cookie-parsed routes because it
   * is server-to-server: no browser, no origin, no cookies involved.
   */
  app.use('/api/webhooks', webhookRoutes);

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Rate limit auth endpoints to blunt credential stuffing / brute force.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Tenant signup lives on the root domain (no tenant context).
  app.use('/api/tenants', tenantRoutes);
  // Auth lives on tenant subdomains (resolveTenant is applied inside).
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/bookings', bookingRoutes);
  // Subscriptions, plan changes and invoice history (Week 3).
  app.use('/api/billing', billingRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
