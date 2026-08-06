import {
  formatMoney,
  monthlyEquivalent,
  yearlySavingPercent,
} from '../lib/billingApi.js';

/**
 * One column of the pricing table.
 *
 * The button's label and behaviour come from the server-computed `action`
 * ('current' | 'upgrade' | 'downgrade') rather than from a client-side
 * comparison, so what the button says can never disagree with what the server
 * would actually do.
 */

const ACTION_LABEL = {
  current: 'Current plan',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
};

/**
 * Same plan, different billing period. Labelled with the destination
 * ("Switch to yearly") rather than a bare "Switch", so the button says what
 * pressing it does.
 */
function labelFor(action, interval) {
  if (action === 'switch_interval') {
    return interval === 'yearly' ? 'Switch to yearly' : 'Switch to monthly';
  }
  return ACTION_LABEL[action] ?? 'Choose plan';
}

export default function PlanCard({
  plan,
  interval,
  isCurrent,
  currentInterval,
  action,
  disabled,
  busy,
  canManageBilling,
  onSelect,
}) {
  const price = plan.prices[interval];
  const isFree = plan.id === 'free';
  // "This exact plan AND interval" — distinct from `isCurrent`, which is
  // plan-level and drives the badge.
  const isCurrentSelection = action === 'current';
  const saving = yearlySavingPercent(
    plan.prices.monthly.amount,
    plan.prices.yearly.amount
  );

  // A paid plan with no Stripe price configured must not offer a button that
  // would fail — it says "contact us" instead.
  const unavailable = !isFree && !price.available;

  return (
    <div
      className={[
        'relative flex flex-col rounded-2xl border bg-white p-6 shadow-sm transition',
        plan.popular && !isCurrent
          ? 'border-brand-300 ring-2 ring-brand-100'
          : 'border-slate-200',
        isCurrent ? 'border-brand-500 ring-2 ring-brand-200' : '',
      ].join(' ')}
    >
      {plan.popular && !isCurrent && (
        <span className="absolute -top-3 left-6 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
          Most popular
        </span>
      )}
      {isCurrent && (
        <span className="absolute -top-3 left-6 rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">
          {/* Naming the interval matters only when you are browsing the other
              one — otherwise "Your plan" beside a "Switch to yearly" button
              reads as a contradiction. */}
          {isCurrentSelection || !currentInterval
            ? 'Your plan'
            : `Your plan · ${currentInterval}`}
        </span>
      )}

      <h3 className="text-lg font-bold text-slate-900">{plan.name}</h3>
      <p className="mt-1 min-h-[2.5rem] text-sm text-slate-500">{plan.tagline}</p>

      <div className="mt-5">
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-extrabold tracking-tight text-slate-900">
            {isFree ? 'Free' : formatMoney(price.amount, plan.currency)}
          </span>
          {!isFree && (
            <span className="text-sm font-medium text-slate-500">
              /{interval === 'yearly' ? 'yr' : 'mo'}
            </span>
          )}
        </div>

        {/* A yearly price is easier to judge against the monthly one people
            already have in mind, so quote the equivalent rather than only the
            annual total. */}
        {!isFree && interval === 'yearly' && (
          <p className="mt-1 text-xs text-slate-500">
            {monthlyEquivalent(price.amount, plan.currency)}/mo billed yearly
            {saving > 0 && (
              <span className="ml-1 font-semibold text-emerald-600">
                · save {saving}%
              </span>
            )}
          </p>
        )}
        {isFree && (
          <p className="mt-1 text-xs text-slate-500">Free forever, no card required.</p>
        )}
      </div>

      <ul className="mt-6 flex-1 space-y-2.5">
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

      <div className="mt-6">
        {unavailable ? (
          <button className="btn w-full bg-slate-100 text-slate-500" disabled>
            Contact sales
          </button>
        ) : (
          <button
            className={[
              'w-full',
              // Disabled state follows the ACTION, not the badge: on Pro
              // monthly while viewing yearly, this is your plan (badge) but
              // still an action you can take (button).
              isCurrentSelection
                ? 'btn border border-slate-200 bg-white text-slate-500'
                : action === 'downgrade'
                  ? 'btn border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  : 'btn-primary',
            ].join(' ')}
            disabled={isCurrentSelection || disabled || busy || !canManageBilling}
            onClick={() => onSelect?.({ planId: plan.id, interval })}
          >
            {busy ? 'Working…' : labelFor(action, interval)}
          </button>
        )}

        {!canManageBilling && !isCurrentSelection && (
          <p className="mt-2 text-center text-xs text-slate-400">
            Only owners and admins can change the plan.
          </p>
        )}
      </div>
    </div>
  );
}

/** Monthly/yearly switch, with the annual discount stated on the control. */
export function IntervalToggle({ value, onChange, savingPercent }) {
  return (
    <div
      className="inline-flex items-center rounded-full border border-slate-200 bg-white p-1 shadow-sm"
      role="group"
      aria-label="Billing interval"
    >
      {['monthly', 'yearly'].map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={[
            'rounded-full px-4 py-1.5 text-sm font-semibold capitalize transition',
            value === option
              ? 'bg-brand-600 text-white'
              : 'text-slate-600 hover:text-slate-900',
          ].join(' ')}
        >
          {option}
          {option === 'yearly' && savingPercent > 0 && (
            <span
              className={[
                'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold',
                value === option
                  ? 'bg-white/20 text-white'
                  : 'bg-emerald-50 text-emerald-700',
              ].join(' ')}
            >
              −{savingPercent}%
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
