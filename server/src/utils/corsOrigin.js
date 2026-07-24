/**
 * Build a CORS origin matcher from a pattern like `http://*.app.local:5173`.
 * The single `*` matches one subdomain label. We also allow the bare root
 * origin (http://app.local:5173) so the landing/signup page can call the API.
 */
export function buildOriginMatcher(pattern, rootDomain) {
  // Escape regex metachars, then turn the `*` back into a subdomain group.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withWildcard = escaped.replace('\\*', '[a-z0-9-]+');
  const subRe = new RegExp(`^${withWildcard}$`, 'i');

  // Root origin = same pattern minus the `*.` subdomain prefix.
  const rootOrigin = pattern.replace('*.', '');
  const rootRe = new RegExp(
    `^${rootOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'i'
  );

  return function originMatcher(origin, callback) {
    // Non-browser clients (curl, server-to-server) send no Origin — allow.
    if (!origin) return callback(null, true);
    if (subRe.test(origin) || rootRe.test(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  };
}
