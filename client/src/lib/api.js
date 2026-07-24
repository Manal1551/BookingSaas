/**
 * Thin fetch wrapper.
 *
 * The API lives on the SAME hostname as the page (so the backend resolves the
 * same tenant from the subdomain) but on the API port. Cookies are httpOnly
 * and sent automatically with `credentials: 'include'`.
 */
const API_PORT = import.meta.env.VITE_API_PORT || '5000';

function apiBase(hostname = window.location.hostname) {
  const proto = window.location.protocol;
  return `${proto}//${hostname}:${API_PORT}`;
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, { body, hostname } = {}) {
  const res = await fetch(`${apiBase(hostname)}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || 'Request failed';
    throw new ApiError(res.status, msg, data && data.details);
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
};

// --- Auth (tenant subdomain) ---
export const authApi = {
  register: (payload) => api.post('/api/auth/register', payload),
  login: (payload) => api.post('/api/auth/login', payload),
  logout: () => api.post('/api/auth/logout'),
  me: () => api.get('/api/auth/me'),
};

// --- Tenant signup (root domain) ---
export const tenantApi = {
  checkSlug: (slug, hostname) =>
    api.get(`/api/tenants/check-slug/${encodeURIComponent(slug)}`, { hostname }),
  create: (payload, hostname) => api.post('/api/tenants', payload, { hostname }),
};
