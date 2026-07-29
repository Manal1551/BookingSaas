import { randomBytes } from 'node:crypto';

// Accept an inbound id only if it is short and alphanumeric — it gets echoed
// into a response header, so it must never carry CRLF or arbitrary content.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Assigns `req.id` and echoes it back as `X-Request-Id`.
 *
 * A caller-supplied `X-Request-Id` is honoured (so a request can be traced
 * across services) when it looks safe; otherwise a fresh sortable id is
 * generated. Every booking error response embeds this id, which is what a user
 * quotes to support.
 */
export function requestId(req, res, next) {
  const inbound = req.get('X-Request-Id');
  req.id =
    inbound && SAFE_ID.test(inbound)
      ? inbound
      : `req_${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
  res.set('X-Request-Id', req.id);
  next();
}
