/**
 * Date helpers bridging the API (ISO 8601 UTC strings) and the browser's
 * `datetime-local` inputs (which speak local wall-clock time, no timezone).
 */

// ISO string -> "YYYY-MM-DDTHH:mm" in the user's local time (for input value).
export function toDatetimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// "YYYY-MM-DDTHH:mm" (local) -> ISO 8601 UTC string for the API.
export function fromDatetimeLocal(local) {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

// A JS Date -> "YYYY-MM-DDTHH:mm" local (used to prefill a clicked calendar slot).
export function dateToDatetimeLocal(date) {
  return toDatetimeLocal(date instanceof Date ? date.toISOString() : date);
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${DATE_FMT.format(d)}, ${TIME_FMT.format(d)}`;
}

// Compact range: same day -> "Mon, Aug 1, 2026 · 10:00 AM – 11:00 AM".
export function formatRange(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '—';
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    return `${DATE_FMT.format(start)} · ${TIME_FMT.format(start)} – ${TIME_FMT.format(end)}`;
  }
  return `${formatDateTime(startIso)} → ${formatDateTime(endIso)}`;
}
