/**
 * Converts Zod issues into the API's flat `details[]` array.
 *
 * Zod reports `path: ['startAt']` relative to whatever was parsed; the API
 * reports it absolute (`body.startAt`, `query.limit`, `params.id`) so a client
 * can map a detail back onto the exact input that produced it.
 */

/**
 * @param {import('zod').ZodIssue[]} issues
 * @param {'body'|'query'|'params'|'headers'} source
 * @returns {import('./appError.js').ErrorDetail[]}
 */
export function zodIssuesToDetails(issues, source) {
  return issues.map((issue) => ({
    path: [source, ...issue.path].join('.'),
    message: issue.message,
  }));
}
