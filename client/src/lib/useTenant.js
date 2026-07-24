const ROOT_DOMAIN = import.meta.env.VITE_ROOT_DOMAIN || 'app.local';

/**
 * Derives the tenant slug from the browser's hostname by stripping ROOT_DOMAIN.
 *   acme.app.local  -> "acme"
 *   app.local       -> null  (root/marketing domain)
 *
 * NOTE: this is used only to LABEL the UI and to build URLs. It is never
 * trusted for authorization — the backend independently re-derives the tenant
 * from the request and cross-checks it against the JWT.
 */
export function getTenantSlug(hostname = window.location.hostname) {
  const host = hostname.toLowerCase();
  const root = ROOT_DOMAIN.toLowerCase();
  if (host === root) return null;
  if (host.endsWith(`.${root}`)) {
    const sub = host.slice(0, -(`.${root}`.length));
    if (!sub || sub.includes('.') || sub === 'www') return null;
    return sub;
  }
  return null;
}

export function useTenant() {
  return getTenantSlug();
}

export function tenantUrl(slug, path = '') {
  const port = import.meta.env.VITE_APP_PORT || '5173';
  const proto = window.location.protocol;
  return `${proto}//${slug}.${ROOT_DOMAIN}:${port}${path}`;
}

export function rootUrl(path = '') {
  const port = import.meta.env.VITE_APP_PORT || '5173';
  const proto = window.location.protocol;
  return `${proto}//${ROOT_DOMAIN}:${port}${path}`;
}

export { ROOT_DOMAIN };
