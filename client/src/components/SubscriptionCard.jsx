import { Link } from 'react-router-dom';
import { describeStatus, formatDate } from '../lib/billingApi.js';

/**
 * The "what am I paying for, and is anything wrong?" panel.
 *
 * Ordered by urgency rather than by data model: a failed payment or a pending
 * cancellation is stated first, in its own coloured strip, because those are
 * the only two things on this page that need action today.
 */

const TONE_STYLES = {
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200',
  error: 'bg-red-50 text-red-700 ring-red-200',
  neutral: 'bg-slate-100 text-slate-600 ring-slate-200',
};

export function StatusPill({ status }) {
  const { label, tone } = describeStatus(status);
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_STYLES[tone] || TONE_STYLES.neutral,
      ].join(' ')}
    >
      {label}
    </span>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-slate-800">{children}</dd>
    </div>
  );
}

export default function SubscriptionCard({
  plan,
  subscription,
  canManageBilling,
  onCancel,
  onResume,
  onOpenPortal,
  busy,
}) {
  const status = subscription?.status;
  const { note, tone } = describeStatus(status);
  const isFree = !subscription || !subscription.entitled;

  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Current plan
          </h2>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-2xl font-bold capitalize text-slate-900">
              {plan?.name ?? 'Free'}
            </span>
            {subscription && <StatusPill status={status} />}
          </div>
          {subscription?.interval && subscription.entitled && (
            <p className="mt-1 text-sm text-slate-500">
              Billed {subscription.interval === 'yearly' ? 'yearly' : 'monthly'}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <Link to="/dashboard/plans" className="btn-primary">
            {isFree ? 'Choose a plan' : 'Change plan'}
          </Link>
          {canManageBilling && subscription && (
            <button className="btn-ghost" onClick={onOpenPortal} disabled={busy}>
              Manage payment
            </button>
          )}
        </div>
      </div>

      {/* Anything that needs attention, stated before the details. */}
      {note && (
        <p
          className={[
            'mt-4 rounded-lg px-3 py-2 text-sm ring-1 ring-inset',
            TONE_STYLES[tone] || TONE_STYLES.neutral,
          ].join(' ')}
        >
          {note}
          {status === 'past_due' && canManageBilling && (
            <button
              className="ml-2 font-semibold underline"
              onClick={onOpenPortal}
              disabled={busy}
            >
              Update card
            </button>
          )}
        </p>
      )}

      {subscription?.cancelAtPeriodEnd && (
        <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          Cancels on <strong>{formatDate(subscription.currentPeriodEnd)}</strong>. You
          keep {plan?.name} until then.
          {canManageBilling && (
            <button
              className="ml-2 font-semibold underline"
              onClick={onResume}
              disabled={busy}
            >
              Keep my subscription
            </button>
          )}
        </div>
      )}

      {subscription && (
        <dl className="mt-6 grid gap-4 border-t border-slate-100 pt-5 sm:grid-cols-3">
          <Field label="Current period">
            {subscription.currentPeriodStart
              ? `${formatDate(subscription.currentPeriodStart)} – ${formatDate(
                  subscription.currentPeriodEnd
                )}`
              : '—'}
          </Field>
          <Field label={subscription.cancelAtPeriodEnd ? 'Access until' : 'Renews on'}>
            {formatDate(subscription.currentPeriodEnd)}
          </Field>
          <Field label="Trial ends">
            {subscription.trialEndsAt ? formatDate(subscription.trialEndsAt) : '—'}
          </Field>
        </dl>
      )}

      {plan?.features?.length > 0 && (
        <div className="mt-6 border-t border-slate-100 pt-5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-400">
            What's included
          </h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {plan.features.map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-slate-600">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full bg-emerald-50 text-[10px] font-bold text-emerald-600"
                >
                  ✓
                </span>
                {feature}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Cancelling is last and quiet — available, never encouraged. */}
      {canManageBilling && subscription?.entitled && !subscription.cancelAtPeriodEnd && (
        <div className="mt-6 border-t border-slate-100 pt-4">
          <button
            className="text-sm font-medium text-slate-400 underline underline-offset-2 hover:text-red-600"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel subscription
          </button>
        </div>
      )}
    </section>
  );
}
