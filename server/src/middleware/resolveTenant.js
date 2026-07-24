import { env } from '../config/env.js';
import { Tenant } from '../models/Tenant.js';
import { tenantStorage } from '../utils/tenantContext.js';
import { HttpError } from '../utils/httpError.js';

/**
 * Extracts the tenant slug (subdomain) from a hostname by stripping ROOT_DOMAIN.
 *   acme.app.local     -> "acme"
 *   app.local          -> null   (bare root, no tenant)
 *   acme.lvh.me        -> "acme"  (if ROOT_DOMAIN=lvh.me)
 * Any port on req.hostname is already stripped by Express.
 */
export function extractSlug(hostname, rootDomain = env.ROOT_DOMAIN) {
  if (!hostname) return null;
  const host = hostname.toLowerCase();
  const root = rootDomain.toLowerCase();

  if (host === root) return null; // bare root domain
  if (host.endsWith(`.${root}`)) {
    const sub = host.slice(0, -(`.${root}`.length));
    // Only a single-label subdomain is a tenant slug (ignore deeper labels).
    if (!sub || sub.includes('.')) return null;
    if (sub === 'www') return null;
    return sub;
  }
  return null;
}

/**
 * Resolves the tenant for the request from its subdomain and binds it to the
 * AsyncLocalStorage context for the remainder of the request.
 *
 * On tenant-scoped API routes, a missing subdomain or unknown tenant is an
 * error. The context is established by running the rest of the middleware
 * chain inside tenantStorage.run(...).
 */
export async function resolveTenant(req, res, next) {
  try {
    const slug = extractSlug(req.hostname);

    if (!slug) {
      throw new HttpError(
        400,
        'No tenant subdomain. Use https://<tenant>.' + env.ROOT_DOMAIN
      );
    }

    // Tenant collection is not tenant-scoped — opt out of the scope plugin.
    const tenant = await Tenant.findOne({ slug })
      .setOptions({ skipTenantScope: true })
      .lean();

    if (!tenant) {
      throw new HttpError(404, `Unknown tenant "${slug}"`);
    }

    req.tenant = tenant;
    // Bind context, then continue the chain inside it so downstream async work
    // (controllers, Mongoose middleware) sees this tenant.
    tenantStorage.run({ tenantId: tenant._id, tenant }, () => next());
  } catch (err) {
    next(err);
  }
}
