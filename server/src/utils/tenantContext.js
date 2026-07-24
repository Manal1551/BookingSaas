import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped tenant context.
 *
 * We use AsyncLocalStorage (NOT a module-level variable) so that concurrent
 * requests never see each other's tenant. Each request runs inside its own
 * `store`, and everything that runs during that request — including Mongoose
 * query middleware — reads the tenant from *this* request's store.
 *
 * The store shape is: { tenantId: ObjectId, tenant: TenantDoc }
 */
export const tenantStorage = new AsyncLocalStorage();

/**
 * Run `callback` with the given tenant bound to the async context.
 * Used by resolveTenant middleware (per HTTP request) and by scripts
 * (seed / verify-isolation) that need to write tenant-scoped data.
 */
export function runWithTenant(tenant, callback) {
  return tenantStorage.run({ tenantId: tenant._id, tenant }, callback);
}

/** Returns the current store or undefined if not inside a tenant context. */
export function getStore() {
  return tenantStorage.getStore();
}

/** Returns the current tenantId or undefined. */
export function getTenantId() {
  return tenantStorage.getStore()?.tenantId;
}

/** Returns the current tenant document or undefined. */
export function getTenant() {
  return tenantStorage.getStore()?.tenant;
}
