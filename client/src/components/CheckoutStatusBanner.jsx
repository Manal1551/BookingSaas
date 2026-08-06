/**
 * The visible half of webhook reconciliation.
 *
 * When the browser returns from Stripe Checkout, the payment has succeeded but
 * the app has not been told yet — that news arrives seconds later as a
 * `checkout.session.completed` webhook. This banner narrates that gap honestly
 * instead of either showing a stale plan or optimistically showing the new one
 * before it is real.
 *
 * Each phase maps to a state of `useCheckoutReconciliation`:
 *   confirming — polling; payment taken, entitlement not yet applied
 *   done       — the webhook landed and the plan is live
 *   timeout    — the webhook never arrived; offer a manual refresh
 *   cancelled  — the user backed out of Checkout; nothing was charged
 */
export default function CheckoutStatusBanner({
  phase,
  planName,
  onRetry,
  onDismiss,
  isSyncing,
}) {
  if (!phase || phase === 'idle') return null;

  if (phase === 'cancelled') {
    return (
      <Banner tone="neutral" onDismiss={onDismiss}>
        <strong className="font-semibold">Checkout cancelled.</strong> No payment was
        taken and your plan is unchanged.
      </Banner>
    );
  }

  if (phase === 'confirming') {
    return (
      <Banner tone="info" spinner>
        <strong className="font-semibold">Payment received — activating your plan…</strong>
        <span className="block text-sm">
          This usually takes a couple of seconds. You can keep working; the page
          updates itself as soon as it is ready.
        </span>
      </Banner>
    );
  }

  if (phase === 'done') {
    return (
      <Banner tone="success" onDismiss={onDismiss}>
        <strong className="font-semibold">
          You&apos;re on {planName ?? 'your new plan'}.
        </strong>{' '}
        Everything is active and your first invoice is below.
      </Banner>
    );
  }

  // phase === 'timeout'
  return (
    <Banner tone="warning">
      <strong className="font-semibold">Still finalising your subscription.</strong>
      <span className="block text-sm">
        Your payment went through, but the confirmation is taking longer than
        usual. Nothing is lost — refresh to check again.
      </span>
      <button
        className="mt-2 text-sm font-semibold underline underline-offset-2"
        onClick={onRetry}
        disabled={isSyncing}
      >
        {isSyncing ? 'Checking…' : 'Refresh billing status'}
      </button>
    </Banner>
  );
}

const TONES = {
  info: 'border-sky-200 bg-sky-50 text-sky-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  neutral: 'border-slate-200 bg-white text-slate-700',
};

function Banner({ tone, children, onDismiss, spinner }) {
  return (
    <div
      // `status`, not `alert`: this is progress the user chose to start, and an
      // assertive interrupt would be wrong for it.
      role="status"
      aria-live="polite"
      className={[
        'flex items-start gap-3 rounded-xl border p-4',
        TONES[tone] || TONES.neutral,
      ].join(' ')}
    >
      {spinner && (
        <span
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          className="-mr-1 -mt-1 flex-shrink-0 rounded p-1 text-lg leading-none opacity-60 hover:opacity-100"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
