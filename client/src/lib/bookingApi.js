import { bookingHttp, BookingApiError, ERROR_CODES } from './bookingClient.js';

export { BookingApiError, ERROR_CODES };

function toQuery(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const bookingApi = {
  /** @param {{from?:string,to?:string,status?:string,resourceId?:string,page?:number,limit?:number,sort?:string}} params */
  list: (params, opts) => bookingHttp.get(`/api/bookings${toQuery(params)}`, opts),

  get: (id, opts) => bookingHttp.get(`/api/bookings/${id}`, opts),

  /**
   * The key is generated ONCE per form session by the caller and reused across
   * every retry of that submission, so a double-click, a flaky network or the
   * transport's own retry can never produce two bookings.
   */
  create: (payload, idempotencyKey, opts = {}) =>
    bookingHttp.post('/api/bookings', payload, {
      ...opts,
      headers: { ...(opts.headers || {}), 'Idempotency-Key': idempotencyKey },
    }),

  /** `version` is the optimistic-concurrency token from the loaded booking. */
  update: (id, patch, version, opts = {}) =>
    bookingHttp.patch(`/api/bookings/${id}`, patch, {
      ...opts,
      headers: { ...(opts.headers || {}), 'If-Match': String(version) },
    }),

  remove: (id, opts) => bookingHttp.delete(`/api/bookings/${id}`, opts),
};

/** Fields a PATCH should carry: only what actually changed. */
export function changedFields(original, next) {
  const patch = {};
  for (const [key, value] of Object.entries(next)) {
    if (original?.[key] !== value) patch[key] = value;
  }
  return patch;
}

/**
 * Message + support id for a toast. The requestId is what a user quotes when
 * asking for help, so it is always surfaced when the server produced one.
 */
export function describeError(err) {
  if (err instanceof BookingApiError) {
    return { message: err.message, requestId: err.requestId, code: err.code };
  }
  return {
    message: 'Something went wrong. Please try again.',
    requestId: null,
    code: ERROR_CODES.INTERNAL_ERROR,
  };
}

export function getErrorMessage(err) {
  return describeError(err).message;
}
