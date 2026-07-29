/**
 * Thin fetch wrapper.
 *
 * The API lives on the SAME hostname as the page (so the backend resolves the
 * same tenant from the subdomain) but on the API port. Cookies are httpOnly
 * and sent automatically with `credentials: 'include'`.
 *
 * Retries: safe/idempotent requests (GET, or any request carrying an
 * `Idempotency-Key`) are retried on network failure or a 5xx response, with a
 * short backoff. Non-idempotent writes are never auto-retried.
 */
const API_PORT = import.meta.env.VITE_API_PORT || '5000';
const MAX_RETRIES = 2;

function apiBase(hostname = window.location.hostname) {
  const proto = window.location.protocol;
  return `${proto}//${hostname}:${API_PORT}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function isRetryable(method, headers) {
  return method === 'GET' || Boolean(headers['Idempotency-Key']);
}

async function request(method, path, { body, hostname, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const retryable = isRetryable(method, headers);
  let lastErr;

  for (let attempt = 0; attempt <= (retryable ? MAX_RETRIES : 0); attempt += 1) {
    if (attempt > 0) await sleep(300 * attempt); // 300ms, 600ms backoff

    let res;
    try {
      res = await fetch(`${apiBase(hostname)}${path}`, {
        method,
        credentials: 'include',
        headers,
        body:
          body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      // Network/DNS/connection failure — retry if allowed, else surface.
      lastErr = new ApiError(0, 'Network error — could not reach the server.');
      if (retryable && attempt < MAX_RETRIES) continue;
      throw lastErr;
    }

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
      // Retry transient server errors on idempotent requests only.
      if (res.status >= 500 && retryable && attempt < MAX_RETRIES) {
        lastErr = new ApiError(res.status, (data && data.error) || 'Server error');
        continue;
      }
      const msg = (data && data.error) || res.statusText || 'Request failed';
      throw new ApiError(res.status, msg, data && data.details);
    }
    return data;
  }

  throw lastErr || new ApiError(0, 'Request failed');
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { ...opts, body }),
  patch: (path, body, opts) => request('PATCH', path, { ...opts, body }),
  delete: (path, opts) => request('DELETE', path, opts),
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
