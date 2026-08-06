import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import DashboardLayout from '../components/DashboardLayout.jsx';
import PlanCard, { IntervalToggle } from '../components/PlanCard.jsx';
import PlanChangeDialog from '../components/PlanChangeDialog.jsx';
import { useAuth } from '../components/TenantContext.jsx';
import { useToast } from '../components/Toast.jsx';
import Modal from '../components/Modal.jsx';
import {
  usePlans,
  useStartCheckout,
  useChangePlan,
  useCancelSubscription,
  rememberPendingCheckout,
} from '../hooks/useBilling.js';
import { yearlySavingPercent, formatDate } from '../lib/billingApi.js';
import { describeError } from '../lib/bookingApi.js';

/**
 * Plans & pricing.
 *
 * Two different flows hide behind the same row of buttons, and which one runs
 * depends on whether there is already an active subscription:
 *
 *   no subscription  -> Stripe Checkout (a hosted, full-page redirect)
 *   has subscription -> in-place plan change, after a proration confirmation
 *
 * The distinction is made here rather than in the button, because it is the
 * server's `subscription` state that decides it — sending an existing
 * subscriber through Checkout would leave them paying for two subscriptions.
 */
export default function Pricing() {
  const { user } = useAuth();
  const toast = useToast();

  const [interval, setInterval] = useState('monthly');
  const [pendingChange, setPendingChange] = useState(null);
  const [confirmDowngradeToFree, setConfirmDowngradeToFree] = useState(false);
  const [busyPlanId, setBusyPlanId] = useState(null);

  const plansQuery = usePlans();
  const checkout = useStartCheckout();
  const changePlan = useChangePlan();
  const cancelSubscription = useCancelSubscription();

  const canManageBilling = ['owner', 'admin'].includes(user?.role);

  /**
   * One idempotency key per page load, reused for every checkout attempt made
   * from this page. A double-clicked button therefore reuses the same Stripe
   * session rather than opening a second one.
   */
  const idempotencyKey = useMemo(
    () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    []
  );

  const plans = plansQuery.data?.plans ?? [];
  const subscription = plansQuery.data?.subscription ?? null;
  const currentPlanId = plansQuery.data?.currentPlanId ?? 'free';
  const currentInterval = plansQuery.data?.currentInterval ?? null;
  const billingEnabled = plansQuery.data?.billingEnabled ?? false;
  const hasActiveSubscription = Boolean(subscription?.entitled);

  const savingPercent = useMemo(() => {
    const pro = plans.find((p) => p.id === 'pro');
    return pro
      ? yearlySavingPercent(pro.prices.monthly.amount, pro.prices.yearly.amount)
      : 0;
  }, [plans]);

  const planName = (id) => plans.find((p) => p.id === id)?.name ?? id;

  async function startCheckout(selection) {
    setBusyPlanId(selection.planId);
    try {
      // Parked before navigating away, so the page we come back to knows what
      // to wait for. React state does not survive a full-page redirect.
      rememberPendingCheckout(selection);

      const { checkout: session } = await checkout.mutateAsync({
        ...selection,
        idempotencyKey,
      });

      // Hand off to Stripe's hosted page — card details never touch this app.
      window.location.assign(session.url);
    } catch (err) {
      const { message, requestId } = describeError(err);
      toast.error(requestId ? `${message} (ref ${requestId})` : message);
      setBusyPlanId(null);
    }
  }

  function onSelectPlan(selection) {
    if (!canManageBilling) return;

    /**
     * Free is not a purchasable price — moving down to it IS cancelling. So
     * the button opens the cancellation confirmation directly rather than
     * sending the user off to find it on another page.
     */
    if (selection.planId === 'free') {
      if (!hasActiveSubscription) return; // already on Free; button is disabled
      setConfirmDowngradeToFree(true);
      return;
    }

    if (hasActiveSubscription) {
      // Existing subscriber: confirm the proration before touching Stripe.
      setPendingChange(selection);
      return;
    }

    startCheckout(selection);
  }

  async function confirmDowngrade() {
    try {
      const result = await cancelSubscription.mutateAsync();
      setConfirmDowngradeToFree(false);
      toast.success(
        `Your subscription ends on ${formatDate(
          result?.cancellation?.accessUntil
        )}. You keep ${planName(currentPlanId)} until then.`
      );
    } catch (err) {
      const { message, requestId } = describeError(err);
      toast.error(requestId ? `${message} (ref ${requestId})` : message);
    }
  }

  async function confirmChange(selection) {
    setBusyPlanId(selection.planId);
    try {
      await changePlan.mutateAsync(selection);
      toast.success(`You are now on ${planName(selection.planId)}.`);
      setPendingChange(null);
    } catch (err) {
      const { message, requestId } = describeError(err);
      toast.error(requestId ? `${message} (ref ${requestId})` : message);
    } finally {
      setBusyPlanId(null);
    }
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl">
        <header className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Plans &amp; pricing
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-slate-500">
            Change plan at any time. Upgrades take effect immediately and are
            prorated; downgrades keep your current features until the period ends.
          </p>

          <div className="mt-6 flex justify-center">
            <IntervalToggle
              value={interval}
              onChange={setInterval}
              savingPercent={savingPercent}
            />
          </div>
        </header>

        {/* Only once the server has actually answered — warning that billing
            is off before we know would flash on every page load. */}
        {plansQuery.data && !billingEnabled && (
          <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <strong className="font-semibold">Billing is not configured.</strong>{' '}
            Prices below are the real catalog, but checkout is switched off until
            Stripe keys are set on the server.
          </div>
        )}

        {plansQuery.isLoading && (
          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[28rem] animate-pulse rounded-2xl bg-white/70" />
            ))}
          </div>
        )}

        {plansQuery.error && (
          <div className="mt-10 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {describeError(plansQuery.error).message}
            <button
              className="ml-2 font-semibold underline"
              onClick={() => plansQuery.refetch()}
            >
              Retry
            </button>
          </div>
        )}

        {plans.length > 0 && (
          <div className="mt-10 grid items-start gap-6 lg:grid-cols-3">
            {plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                interval={interval}
                isCurrent={plan.id === currentPlanId}
                currentInterval={currentInterval}
                // Per-interval, so switching monthly <-> yearly on the plan
                // you are already on stays reachable.
                action={plan.actions?.[interval]}
                canManageBilling={canManageBilling}
                disabled={!billingEnabled || Boolean(busyPlanId)}
                busy={busyPlanId === plan.id}
                onSelect={onSelectPlan}
              />
            ))}
          </div>
        )}

        {subscription?.cancelAtPeriodEnd && (
          <p className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-4 text-center text-sm text-amber-800">
            Your subscription is scheduled to end. Picking a plan above will keep
            it running instead.
          </p>
        )}

        <p className="mt-10 text-center text-sm text-slate-500">
          Looking for past invoices?{' '}
          <Link to="/dashboard/billing" className="font-medium text-brand-600 underline">
            Go to billing
          </Link>
        </p>
      </div>

      <PlanChangeDialog
        open={Boolean(pendingChange)}
        selection={pendingChange}
        currentPlanName={planName(currentPlanId)}
        targetPlanName={planName(pendingChange?.planId)}
        submitting={changePlan.isPending}
        onConfirm={confirmChange}
        onClose={() => setPendingChange(null)}
      />

      {/* Moving to Free means cancelling, so it gets its own confirmation
          rather than the proration dialog — there is no proration to quote. */}
      <Modal
        open={confirmDowngradeToFree}
        onClose={() => setConfirmDowngradeToFree(false)}
        title="Move down to Free?"
        footer={
          <>
            <button
              className="btn-ghost"
              onClick={() => setConfirmDowngradeToFree(false)}
              disabled={cancelSubscription.isPending}
            >
              Keep {planName(currentPlanId)}
            </button>
            <button
              className="btn bg-red-600 text-white hover:bg-red-700"
              onClick={confirmDowngrade}
              disabled={cancelSubscription.isPending}
            >
              {cancelSubscription.isPending ? 'Cancelling…' : 'Move to Free'}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Moving to Free cancels your subscription. It stays active until{' '}
          <strong>{formatDate(subscription?.currentPeriodEnd)}</strong> — you have
          already paid for this period and keep every {planName(currentPlanId)}{' '}
          feature until then.
        </p>
        <p className="mt-3 text-sm text-slate-600">
          After that this workspace moves to the Free plan. Nothing is deleted:
          your bookings stay readable and editable, but anything above the Free
          limits can no longer grow.
        </p>
        <p className="mt-3 text-sm text-slate-500">
          You can undo this at any time before that date.
        </p>
      </Modal>
    </DashboardLayout>
  );
}
