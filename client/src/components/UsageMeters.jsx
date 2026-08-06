import { Link } from 'react-router-dom';
import { formatDate } from '../lib/billingApi.js';

/**
 * Consumption against the plan's limits.
 *
 * Deliberately shows the number *and* the bar. A bar alone tells you roughly
 * how full you are; "47 of 50 bookings" tells you whether you can create three
 * more, which is the question people actually have. Unlimited limits render as
 * a plain count with no bar, because a progress bar with no end is noise.
 */

const METERS = [
  {
    key: 'bookingsPerMonth',
    label: 'Bookings this month',
    unit: 'bookings',
    resets: true,
  },
  { key: 'teamMembers', label: 'Team members', unit: 'members' },
  { key: 'resources', label: 'Bookable resources', unit: 'resources' },
];

/** Warn before the wall, not at it. */
function toneFor({ used, limit, exceeded }) {
  if (limit === null) return 'unlimited';
  if (exceeded) return 'exceeded';
  if (used / limit >= 0.8) return 'warning';
  return 'ok';
}

const BAR = {
  ok: 'bg-brand-500',
  warning: 'bg-amber-500',
  exceeded: 'bg-red-500',
};

const VALUE_TEXT = {
  ok: 'text-slate-900',
  warning: 'text-amber-700',
  exceeded: 'text-red-700',
  unlimited: 'text-slate-900',
};

function Meter({ label, unit, meter, resets, periodEnd }) {
  const tone = toneFor(meter);
  const unlimited = meter.limit === null;
  // Clamped only for the BAR's width — the number above it always tells the
  // truth, including when a downgrade left the tenant over its limit.
  const percent = unlimited ? 0 : Math.min(100, (meter.used / meter.limit) * 100);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-slate-600">{label}</span>
        <span className={['text-sm font-semibold tabular-nums', VALUE_TEXT[tone]].join(' ')}>
          {unlimited ? (
            <>
              {meter.used.toLocaleString()}{' '}
              <span className="font-normal text-slate-400">· unlimited</span>
            </>
          ) : (
            <>
              {meter.used.toLocaleString()}
              <span className="font-normal text-slate-400">
                {' '}
                / {meter.limit.toLocaleString()}
              </span>
            </>
          )}
        </span>
      </div>

      {!unlimited && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-valuenow={meter.used}
          aria-valuemin={0}
          aria-valuemax={meter.limit}
          aria-label={label}
        >
          <div
            className={['h-full rounded-full transition-all', BAR[tone]].join(' ')}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {tone === 'exceeded' && (
        <p className="mt-1.5 text-xs text-red-600">
          Limit reached — you cannot add more {unit} until you upgrade
          {resets && periodEnd ? ` or the month resets on ${formatDate(periodEnd)}` : ''}.
        </p>
      )}
      {tone === 'warning' && (
        <p className="mt-1.5 text-xs text-amber-700">
          {meter.remaining} {unit} left on this plan.
        </p>
      )}
    </div>
  );
}

export default function UsageMeters({ data, loading }) {
  if (loading) {
    return (
      <section className="card" aria-busy="true">
        <div className="h-4 w-32 animate-pulse rounded bg-slate-100" />
        <div className="mt-6 space-y-6">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </section>
    );
  }

  if (!data?.usage) return null;

  const anyExceeded = Object.values(data.usage).some((m) => m.exceeded);

  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800">Usage</h2>
          <p className="mt-1 text-sm text-slate-500">
            Against your <span className="capitalize">{data.planName}</span> plan
            {data.periodEnd && `, resetting ${formatDate(data.periodEnd)}`}.
          </p>
        </div>
        {anyExceeded && (
          <Link to="/dashboard/plans" className="btn-primary">
            Upgrade
          </Link>
        )}
      </div>

      <div className="mt-6 space-y-6">
        {METERS.map(({ key, label, unit, resets }) =>
          data.usage[key] ? (
            <Meter
              key={key}
              label={label}
              unit={unit}
              meter={data.usage[key]}
              resets={resets}
              periodEnd={data.periodEnd}
            />
          ) : null
        )}
      </div>

      {/* Stated explicitly, because "I hit a limit" naturally reads as "am I
          about to lose my data?" — and the answer is no. */}
      {anyExceeded && (
        <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-500">
          Nothing is deleted or hidden when you pass a limit. Everything you
          already have stays fully readable and editable — you just can&apos;t
          add more until you upgrade.
        </p>
      )}
    </section>
  );
}
