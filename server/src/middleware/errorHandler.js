import { isProd } from '../config/env.js';
import { HttpError } from '../utils/httpError.js';

// 404 for unmatched routes.
export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Central error handler. Never leak stack traces or secrets to clients.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  const status = err instanceof HttpError ? err.status : 500;

  if (status >= 500) {
    // Log server errors, but nothing sensitive travels to the client.
    console.error('[error]', err.message);
    if (!isProd) console.error(err.stack);
  }

  const body = { error: status >= 500 ? 'Internal server error' : err.message };
  if (err instanceof HttpError && err.details) body.details = err.details;
  res.status(status).json(body);
}
