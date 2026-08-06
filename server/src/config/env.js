import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env before validating. In production the vars usually come from the
// orchestrator's environment, so a missing .env file is not itself an error.
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  MONGODB_URI: z
    .string()
    .min(1, 'MONGODB_URI is required')
    .refine(
      (v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'),
      'MONGODB_URI must start with mongodb:// or mongodb+srv://'
    ),

  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES: z.string().min(1).default('15m'),
  JWT_REFRESH_EXPIRES: z.string().min(1).default('7d'),

  ROOT_DOMAIN: z.string().min(1).default('app.local'),
  CLIENT_ORIGIN_PATTERN: z
    .string()
    .min(1)
    .default('http://*.app.local:5173'),

  // --- Week 3: Stripe billing -------------------------------------------
  // Every Stripe var is OPTIONAL on purpose. The app must still boot (and the
  // Week 1/2 test suites must still run) on a machine with no Stripe account;
  // `isBillingConfigured()` gates the billing routes at request time instead of
  // failing the whole process at import time.
  STRIPE_SECRET_KEY: z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith('sk_') || v.startsWith('rk_'),
      'STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_/rk_)'
    )
    .optional(),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .min(1)
    .refine(
      (v) => v.startsWith('whsec_'),
      'STRIPE_WEBHOOK_SECRET must start with whsec_'
    )
    .optional(),

  // Price IDs, one per plan/interval cell of the pricing table. A plan whose
  // price ID is absent is served as "unavailable" rather than 500ing at
  // checkout.
  STRIPE_PRICE_PRO_MONTHLY: z.string().min(1).optional(),
  STRIPE_PRICE_PRO_YEARLY: z.string().min(1).optional(),
  STRIPE_PRICE_BUSINESS_MONTHLY: z.string().min(1).optional(),
  STRIPE_PRICE_BUSINESS_YEARLY: z.string().min(1).optional(),

  // Where Checkout returns the browser. `{slug}` is substituted with the
  // tenant's subdomain so each tenant lands back on its own workspace.
  BILLING_RETURN_URL: z
    .string()
    .min(1)
    .default('http://{slug}.app.local:5173/dashboard/billing'),

  // Reject webhook events whose signature timestamp is older than this, so a
  // captured request cannot be replayed days later.
  STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
});

/**
 * `FOO=` in a .env file yields an empty string, not `undefined` — which would
 * fail the optional Stripe vars' `.min(1)` and hard-stop the process on a
 * machine that simply has no Stripe account yet. Treat blank as absent.
 */
function withoutBlanks(source) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

const parsed = envSchema.safeParse(withoutBlanks(process.env));

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Fail fast. Never print the values — only which keys are wrong.
  console.error(
    '\n❌ Invalid or missing environment variables:\n' +
      issues +
      '\n\nCopy server/.env.example to server/.env and fill in the values.\n'
  );
  process.exit(1);
}

// Cross-field check: the two secrets must differ, otherwise refresh tokens
// would be accepted as access tokens and vice versa.
if (parsed.data.JWT_ACCESS_SECRET === parsed.data.JWT_REFRESH_SECRET) {
  console.error(
    '\n❌ JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.\n'
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
