/**
 * Transport for the Booking API.
 *
 * Deliberately separate from `lib/api.js`: Week 1 routes still answer with the
 * flat `{ error: "message" }` shape that Login/Register/Landing parse, while
 * `/api/bookings/*` answers with the Week 2 envelope:
 *
 *   { error: { code, message, details[], requestId } }
 *
 * Keeping the two clients apart means the booking UI gets typed error codes
 * without touching a single Week 1 file.
 */

const API_PORT = import.meta.env.VITE_API_PORT || '5000';

/** Total attempts for a retryable request (1 initial + 2 retries). */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

/** Error codes the API can return — mirrors the server's ERROR_CODES union. */
export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BOOKING_CONFLICT: 'BOOKING_CONFLICT',
  IDEMPOTENCY_KEY_REUSE: 'IDEMPOTENCY_KEY_REUSE',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  STALE_RESOURCE: 'STALE_RESOURCE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR', // client-side only: never reached the server
});

/** A parsed error envelope. */
export class BookingApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message || 'Something went wrong.');
    this.name = 'BookingApiError';
    this.status = status ?? 0;
    this.code = code || ERROR_CODES.INTERNAL_ERROR;
    this.details = Array.isArray(details) ? details : [];
    this.requestId = requestId || null;
  }

  /**
   * Server `details[].path` values are absolute (`body.startAt`). Strip the
   * source prefix so they can be handed straight to react-hook-form's
   * `setError(field, ...)`.
   *
   * @returns {Record<string, string>}
   */
  fieldErrors() {
    const out = {};
    for (const d of this.details) {
      if (typeof d?.path !== 'string') continue;
      const [source, ...rest] = d.path.split('.');
      if (source !== 'body' || rest.length === 0) continue;
      const field = rest.join('.');
      if (!(field in out)) out[field] = d.message;
    }
    return out;
  }

  /** True when retrying could plausibly succeed. */
  get isTransient() {
    return this.status === 0 || this.status >= 500;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, so retries never sync up. */
function backoffDelay(attempt) {
  const ceiling = BASE_DELAY_MS * 2 ** attempt;
  return Math.random() * ceiling;
}

function apiBase() {
  const { protocol, hostname } = window.location;
  // Same hostname as the page so the server resolves the same tenant from the
  // subdomain; only the port differs.
  return `${protocol}//${hostname}:${API_PORT}`;
}

/**
 * A request may be retried only if repeating it cannot create a second
 * side effect: GET is naturally safe, and POST/DELETE are safe here precisely
 * because they carry an Idempotency-Key (or, for DELETE, are idempotent by
 * definition server-side). PATCH is never retried — it is guarded by a
 * version, and a blind retry would report STALE_RESOURCE.
 */
function isRetryable(method, headers) {
  if (method === 'GET') return true;
  if (method === 'DELETE') return true;
  if (method === 'POST') return Boolean(headers['Idempotency-Key']);
  return false;
}

async function parseBody(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(res, data) {
  const envelope = data && typeof data === 'object' ? data.error : null;
  if (envelope && typeof envelope === 'object') {
    return new BookingApiError({
      status: res.status,
      code: envelope.code,
      message: envelope.message,
      details: envelope.details,
      requestId: envelope.requestId || res.headers.get('X-Request-Id'),
    });
  }
  // A proxy or an unexpected middleware answered — synthesise an envelope.
  return new BookingApiError({
    status: res.status,
    code: res.status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_ERROR,
    message:
      typeof data === 'string' && data
        ? data
        : res.statusText || `Request failed with status ${res.status}`,
    requestId: res.headers.get('X-Request-Id'),
  });
}

/**
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path
 * @param {{ body?: unknown, headers?: Record<string,string>, signal?: AbortSignal,
 *          onRetry?: (info: { attempt: number, error: BookingApiError }) => void }} [opts]
 */
export async function bookingRequest(method, path, opts = {}) {
  const { body, headers: extraHeaders, signal, onRetry } = opts;

  const headers = { ...(extraHeaders || {}) };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';

  const retryable = isRetryable(method, headers);
  const attempts = retryable ? MAX_ATTEMPTS : 1;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      onRetry?.({ attempt, error: lastError });
      await sleep(backoffDelay(attempt - 1));
    }

    let res;
    try {
      res = await fetch(`${apiBase()}${path}`, {
        method,
        credentials: 'include', // httpOnly auth cookies
        headers,
        signal,
        body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastError = new BookingApiError({
        status: 0,
        code: ERROR_CODES.NETWORK_ERROR,
        message: navigator.onLine
          ? 'Could not reach the server. Check your connection and try again.'
          : 'You appear to be offline.',
      });
      if (attempt < attempts - 1) continue;
      throw lastError;
    }

    const data = await parseBody(res);

    if (res.ok) return data;

    const error = toApiError(res, data);

    // 4xx is a client-side problem: retrying cannot change the outcome.
    if (!error.isTransient || attempt === attempts - 1) throw error;
    lastError = error;
  }

  throw lastError ?? new BookingApiError({ status: 0, message: 'Request failed.' });
}

export const bookingHttp = {
  get: (path, opts) => bookingRequest('GET', path, opts),
  post: (path, body, opts) => bookingRequest('POST', path, { ...opts, body }),
  patch: (path, body, opts) => bookingRequest('PATCH', path, { ...opts, body }),
  delete: (path, opts) => bookingRequest('DELETE', path, opts),
};
