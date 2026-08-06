import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import DashboardLayout from '../components/DashboardLayout.jsx';
import SubscriptionCard from '../components/SubscriptionCard.jsx';
import InvoiceTable from '../components/InvoiceTable.jsx';
import UsageMeters from '../components/UsageMeters.jsx';
import CheckoutStatusBanner from '../components/CheckoutStatusBanner.jsx';
import Modal from '../components/Modal.jsx';
import { useAuth } from '../components/TenantContext.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  useSubscription,
  useInvoices,
  useUsage,
  useCancelSubscription,
  useResumeSubscription,
  useOpenPortal,
  useCheckoutReconciliation,
  readPendingCheckout,
  clearPendingCheckout,
} from '../hooks/useBilling.js';
import { formatDate } from '../lib/billingApi.js';
import { describeError } from '../lib/bookingApi.js';

const PAGE_SIZE = 10;

/**
 * Billing home: current subscription, payment health, and invoice history.
 *
 * This is also where Stripe returns the browser after Checkout, so it owns the
 * reconciliation between "Stripe says paid" and "our database says paid" — see
 * `useCheckoutReconciliation`. Everything on the page reads from the local
 * mirror the webhooks maintain, which is why it renders instantly and stays
 * readable even when Stripe is slow.
 */
export default function Billing() {
  const { user, hydrate } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [page, setPage] = useState(1);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const canManageBilling = ['owner', 'admin'].includes(user?.role);

  // Stripe appends these on the way back from its hosted pages.
  const checkoutParam = searchParams.get('checkout');
  const returningFromCheckout = checkoutParam === 'success';
  const cancelledCheckout = checkoutParam === 'cancelled';

  const [pending] = useState(() => readPendingCheckout());

  /**
   * The tenant's plan is baked into the auth session (the dashboard header
   * shows it), so a plan change has to refresh that session too — otherwise
   * the header keeps claiming the old plan until the next full page load.
   */
  const onReconciled = useCallback(() => {
    hydrate();
  }, [hydrate]);

  const reconciliation = useCheckoutReconciliation({
    enabled: returningFromCheckout,
    expected: pending,
    onSettled: onReconciled,
  });

  // Not polling: this is the ordinary read that feeds the page. While a
  // checkout is being confirmed, the reconciler's own polling query shares
  // this cache key, so both views stay in step automatically.
  const subscriptionQuery = useSubscription({ pollWhile: false });

  const invoicesQuery = useInvoices({ page, limit: PAGE_SIZE });
  const usageQuery = useUsage();

  const cancel = useCancelSubscription();
  const resume = useResumeSubscription();
  const portal = useOpenPortal();

  // Once confirmed, drop the Stripe params so a refresh (or a shared link)
  // does not replay the "activating…" flow against an already-settled state.
  useEffect(() => {
    if (reconciliation.phase !== 'done') return;
    const next = new URLSearchParams(searchParams);
    next.delete('checkout');
    next.delete('session_id');
    setSearchParams(next, { replace: true });
  }, [reconciliation.phase, searchParams, setSearchParams]);

  useEffect(() => {
    if (cancelledCheckout) clearPendingCheckout();
  }, [cancelledCheckout]);

  function dismissBanner() {
    const next = new URLSearchParams(searchParams);
    next.delete('checkout');
    next.delete('session_id');
    setSearchParams(next, { replace: true });
  }

  function reportError(err) {
    const { message, requestId } = describeError(err);
    toast.error(requestId ? `${message} (ref ${requestId})` : message);
  }

  async function onOpenPortal() {
    try {
      const { portal: session } = await portal.mutateAsync();
      window.location.assign(session.url);
    } catch (err) {
      reportError(err);
    }
  }

  async function onConfirmCancel() {
    try {
      const result = await cancel.mutateAsync();
      setConfirmCancel(false);
      toast.success(
        `Cancelled. You keep your plan until ${formatDate(
          result?.cancellation?.accessUntil
        )}.`
      );
    } catch (err) {
      reportError(err);
    }
  }

  async function onResume() {
    try {
      await resume.mutateAsync();
      toast.success('Your subscription will continue as normal.');
    } catch (err) {
      reportError(err);
    }
  }

  const subscription = subscriptionQuery.data?.subscription ?? null;
  const plan = subscriptionQuery.data?.plan ?? null;
  const invoices = invoicesQuery.data?.invoices ?? [];
  const totalPages = invoicesQuery.data?.totalPages ?? 1;

  const bannerPhase = cancelledCheckout ? 'cancelled' : reconciliation.phase;
  const busy = cancel.isPending || resume.isPending || portal.isPending;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
          <p className="mt-1 text-slate-500">
            Manage your subscription, payment method and invoice history.
          </p>
        </header>

        <CheckoutStatusBanner
          phase={bannerPhase}
          planName={plan?.name}
          onRetry={reconciliation.retry}
          onDismiss={dismissBanner}
          isSyncing={reconciliation.isSyncing}
        />

        {subscriptionQuery.isLoading ? (
          <div className="h-64 animate-pulse rounded-2xl bg-white/70" />
        ) : subscriptionQuery.error ? (
          <div className="card border-red-200 bg-red-50 text-sm text-red-700">
            {describeError(subscriptionQuery.error).message}
            <button
              className="ml-2 font-semibold underline"
              onClick={() => subscriptionQuery.refetch()}
            >
              Retry
            </button>
          </div>
        ) : (
          <SubscriptionCard
            plan={plan}
            subscription={subscription}
            canManageBilling={canManageBilling}
            busy={busy}
            onCancel={() => setConfirmCancel(true)}
            onResume={onResume}
            onOpenPortal={onOpenPortal}
          />
        )}

        <UsageMeters data={usageQuery.data} loading={usageQuery.isLoading} />

        <section className="card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-slate-800">Billing history</h2>
              <p className="mt-1 text-sm text-slate-500">
                Invoices are issued by Stripe; receipts and PDFs open there.
              </p>
            </div>
            {invoicesQuery.isFetching && !invoicesQuery.isLoading && (
              <span className="text-xs text-slate-400">Refreshing…</span>
            )}
          </div>

          <div className="mt-5">
            {invoicesQuery.error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {describeError(invoicesQuery.error).message}
                <button
                  className="ml-2 font-semibold underline"
                  onClick={() => invoicesQuery.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : (
              <InvoiceTable
                invoices={invoices}
                loading={invoicesQuery.isLoading}
                emptyHint={
                  subscription
                    ? 'Your first invoice will appear here once it is issued.'
                    : 'Choose a plan to get started — invoices appear here afterwards.'
                }
              />
            )}
          </div>

          {totalPages > 1 && (
            <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
              <button
                className="btn-ghost"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || invoicesQuery.isFetching}
              >
                Previous
              </button>
              <span className="text-sm text-slate-500">
                Page {page} of {totalPages}
              </span>
              <button
                className="btn-ghost"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || invoicesQuery.isFetching}
              >
                Next
              </button>
            </div>
          )}
        </section>
      </div>

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel subscription?"
        footer={
          <>
            <button className="btn-ghost" onClick={() => setConfirmCancel(false)}>
              Keep my plan
            </button>
            <button
              className="btn bg-red-600 text-white hover:bg-red-700"
              onClick={onConfirmCancel}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel subscription'}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          Your subscription stays active until{' '}
          <strong>{formatDate(subscription?.currentPeriodEnd)}</strong> — you have
          already paid for this period and keep every feature until then.
        </p>
        <p className="mt-3 text-sm text-slate-600">
          After that this workspace moves to the Free plan. Your bookings are not
          deleted, but anything over the Free limits becomes read-only.
        </p>
        <p className="mt-3 text-sm text-slate-500">
          You can undo this at any time before that date.
        </p>
      </Modal>
    </DashboardLayout>
  );
}
