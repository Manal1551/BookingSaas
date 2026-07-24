import { z } from 'zod';
import { Tenant } from '../models/Tenant.js';
import { HttpError, asyncHandler } from '../utils/httpError.js';

/**
 * These endpoints are served on the ROOT domain (no tenant context) — they are
 * how a brand-new company creates its tenant/subdomain. They deliberately do
 * NOT go through resolveTenant.
 */

const slugSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/,
    'slug must be lowercase alphanumeric/dashes'
  );

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema,
  plan: z.enum(['free', 'pro']).optional(),
});

// Reserved subdomains that cannot be claimed as tenant slugs.
const RESERVED = new Set(['www', 'api', 'admin', 'app', 'mail', 'static']);

// GET /api/tenants/check-slug/:slug
export const checkSlug = asyncHandler(async (req, res) => {
  const parsed = slugSchema.safeParse((req.params.slug || '').toLowerCase());
  if (!parsed.success) {
    return res.json({ slug: req.params.slug, available: false, reason: 'invalid' });
  }
  const slug = parsed.data;
  if (RESERVED.has(slug)) {
    return res.json({ slug, available: false, reason: 'reserved' });
  }
  const existing = await Tenant.findOne({ slug })
    .setOptions({ skipTenantScope: true })
    .lean();
  res.json({ slug, available: !existing });
});

// POST /api/tenants
export const createTenant = asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, 'Validation failed', parsed.error.flatten());
  }
  const { name, plan } = parsed.data;
  const slug = parsed.data.slug.toLowerCase();

  if (RESERVED.has(slug)) throw new HttpError(409, 'That subdomain is reserved');

  const existing = await Tenant.findOne({ slug })
    .setOptions({ skipTenantScope: true })
    .lean();
  if (existing) throw new HttpError(409, 'That subdomain is already taken');

  const tenant = await Tenant.create({ name, slug, plan: plan || 'free' });
  res.status(201).json({
    tenant: { id: tenant._id, name: tenant.name, slug: tenant.slug, plan: tenant.plan },
  });
});
