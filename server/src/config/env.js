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
});

const parsed = envSchema.safeParse(process.env);

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
