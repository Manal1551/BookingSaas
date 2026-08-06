import Modal from './Modal.jsx';
import { usePlanChangePreview } from '../hooks/useBilling.js';
import { formatMoney, formatDate } from '../lib/billingApi.js';
import { describeError } from '../lib/bookingApi.js';

/**
 * Confirmation step for switching an EXISTING subscription to another plan.
 *
 * It exists because mid-cycle proration is the most surprising part of
 * subscription billing: an upgrade typically charges the prorated difference
 * immediately, a downgrade typically leaves a credit rather than a refund.
 * The figures shown are Stripe's own preview, not an estimate computed here,
 * so what the dialog promises is what the invoice will say.
 */
export default function PlanChangeDialog({
  open,
  selection,
  currentPlanName,
  targetPlanName,
  onConfirm,
  onClose,
  submitting,
}) {
  // Quoted only while the dialog is open, and never cached — a proration
  // amount is only valid for the moment it was calculated.
  const preview = usePlanChangePreview(open ? selection : null);

  const data = preview.data?.preview;
  const isDowngrade = data?.direction === 'downgrade';

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={isDowngrade ? 'Confirm downgrade' : 'Confirm upgrade'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => onConfirm(selection)}
            disabled={submitting || preview.isLoading || Boolean(preview.error)}
          >
            {submitting
              ? 'Applying…'
              : isDowngrade
                ? `Switch to ${targetPlanName}`
                : `Upgrade to ${targetPlanName}`}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        You are moving from <strong>{currentPlanName}</strong> to{' '}
        <strong>{targetPlanName}</strong>
        {selection?.interval === 'yearly' ? ', billed yearly' : ', billed monthly'}.
      </p>

      {preview.isLoading && (
        <div className="mt-4 space-y-2" aria-live="polite">
          <div className="h-4 w-2/3 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-slate-100" />
          <p className="text-xs text-slate-400">Calculating what this costs today…</p>
        </div>
      )}

      {preview.error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {describeError(preview.error).message}
        </div>
      )}

      {data && (
        <div className="mt-4 space-y-4">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-slate-600">
                {isDowngrade ? 'Charged today' : 'Due today'}
              </span>
              <span className="text-xl font-bold text-slate-900">
                {formatMoney(data.amountDueNow, data.currency)}
              </span>
            </div>

            {/* A negative proration total is a credit, not a refund — say so,
                because "-$14.00" alone reads as money coming back. */}
            {data.prorationTotal < 0 && (
              <p className="mt-2 text-xs text-emerald-700">
                A credit of {formatMoney(Math.abs(data.prorationTotal), data.currency)}{' '}
                will be applied to your next invoice.
              </p>
            )}

            {data.nextBillingAt && (
              <p className="mt-2 text-xs text-slate-500">
                Next invoice on {formatDate(data.nextBillingAt)}.
              </p>
            )}
          </div>

          {data.lines?.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                Breakdown
              </h3>
              <ul className="mt-2 divide-y divide-slate-100 text-sm">
                {data.lines.map((line, i) => (
                  <li key={i} className="flex items-start justify-between gap-4 py-2">
                    <span className="min-w-0 flex-1 text-slate-600">
                      {line.description || 'Adjustment'}
                      {line.proration && (
                        <span className="ml-1 text-xs text-slate-400">(prorated)</span>
                      )}
                    </span>
                    <span
                      className={[
                        'flex-shrink-0 font-medium tabular-nums',
                        line.amount < 0 ? 'text-emerald-600' : 'text-slate-900',
                      ].join(' ')}
                    >
                      {formatMoney(line.amount, data.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isDowngrade && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              You keep {currentPlanName} features until the end of the current
              period, then move to {targetPlanName}. Anything above the new plan's
              limits stays readable but can no longer grow.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
