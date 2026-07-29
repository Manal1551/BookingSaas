const STATUS_STYLES = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-200',
  confirmed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  cancelled: 'bg-red-50 text-red-700 ring-red-200',
  completed: 'bg-slate-100 text-slate-600 ring-slate-200',
};

// Hex colors used for FullCalendar event dots/backgrounds (kept in sync above).
export const STATUS_COLORS = {
  pending: '#d97706',
  confirmed: '#059669',
  cancelled: '#dc2626',
  completed: '#64748b',
};

export default function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.completed;
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
        style,
      ].join(' ')}
    >
      {status}
    </span>
  );
}
