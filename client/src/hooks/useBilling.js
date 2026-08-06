import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { billingApi } from '../lib/billingApi.js';

/**
 * TanStack Query bindings for the Billing API.
 *
 * `retry: false` throughout, for the same reason as the booking hooks: the
 * transport already retries idempotent requests with jittered backoff, and
 * letting Query retry as well would multiply the attempts.
 */

export const billingKeys = {
  all: ['billing'],
  plans: () => ['billing', 'plans'],
  subscription: () => ['billing', 'subscription'],
  invoices: (params) => ['billing', 'invoices', params],
  usage: () => ['billing', 'usage'],
  preview: (selection) => ['billing', 'preview', selection],
};

/**
 * Invalidates every billing view at once.
 *
 * Any mutation can move any of them — a plan change rewrites the subscription,
 * re-labels the plan cards, and files a proration invoice — so they are always
 * refreshed as a set rather than individually.
 */
function useInvalidateBilling() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: billingKeys.all }), [qc]);
}

export function usePlans(options = {}) {
  return useQuery({
    queryKey: billingKeys.plans(),
    queryFn: ({ signal }) => billingApi.plans({ signal }),
    retry: false,
    ...options,
  });
}

/**
 * The subscription, optionally polled.
 *
 * `pollWhile` turns this into the mechanism that makes webhook-driven changes
 * feel instant: after returning from Stripe the UI does not know when the
 * webhook will land, so it watches this endpoint until the state it is waiting
 * for appears. Polling is opt-in and self-limiting — never a background timer
 * that runs for the life of the session.
 */
export function useSubscription({ pollWhile = false, intervalMs = 2000, ...options } = {}) {
  return useQuery({
    queryKey: billingKeys.subscription(),
    queryFn: ({ signal }) => billingApi.subscription({ signal }),
    retry: false,
    refetchInterval: pollWhile ? intervalMs : false,
    // Keep polling if the user tabs away mid-checkout and comes back.
    refetchIntervalInBackground: false,
    ...options,
  });
}

export function useInvoices(params, options = {}) {
  return useQuery({
    queryKey: billingKeys.invoices(params),
    queryFn: ({ signal }) => billingApi.invoices(params, { signal }),
    retry: false,
    ...options,
  });
}

/**
 * Consumption against the plan's limits.
 *
 * Kept short-lived: usage changes with every booking created anywhere in the
 * workspace, and a stale meter that says "12 of 50" while the API is already
 * refusing writes is worse than no meter at all.
 */
export function useUsage(options = {}) {
  return useQuery({
    queryKey: billingKeys.usage(),
    queryFn: ({ signal }) => billingApi.usage({ signal }),
    retry: false,
    staleTime: 10_000,
    ...options,
  });
}

/**
 * Proration quote for a pending plan switch. Disabled until a plan is actually
 * picked, so opening the dialog is what triggers the quote — not hovering.
 */
export function usePlanChangePreview(selection, options = {}) {
  return useQuery({
    queryKey: billingKeys.preview(selection),
    queryFn: ({ signal }) => billingApi.preview(selection, { signal }),
    enabled: Boolean(selection?.planId && selection?.interval),
    retry: false,
    // A quote is only good for the moment it was made.
    staleTime: 0,
    gcTime: 0,
    ...options,
  });
}

/**
 * Starts Checkout and hands the browser to Stripe.
 *
 * The idempotency key is minted by the caller once per page load, so a
 * double-click or a retried request reuses the same Stripe session instead of
 * opening a second one.
 */
export function useStartCheckout(options = {}) {
  return useMutation({
    mutationFn: ({ planId, interval, idempotencyKey }) =>
      billingApi.checkout({ planId, interval }, idempotencyKey),
    retry: false,
    ...options,
  });
}

export function useOpenPortal(options = {}) {
  return useMutation({
    mutationFn: () => billingApi.portal(),
    retry: false,
    ...options,
  });
}

export function useChangePlan(options = {}) {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: ({ planId, interval }) => billingApi.change({ planId, interval }),
    retry: false,
    onSuccess: (...args) => {
      invalidate();
      options.onSuccess?.(...args);
    },
    ...options,
  });
}

export function useCancelSubscription(options = {}) {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: () => billingApi.cancel(),
    retry: false,
    onSuccess: (...args) => {
      invalidate();
      options.onSuccess?.(...args);
    },
    ...options,
  });
}

export function useResumeSubscription(options = {}) {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: () => billingApi.resume(),
    retry: false,
    onSuccess: (...args) => {
      invalidate();
      options.onSuccess?.(...args);
    },
    ...options,
  });
}

export function useSyncBilling(options = {}) {
  const invalidate = useInvalidateBilling();
  return useMutation({
    mutationFn: () => billingApi.sync(),
    retry: false,
    onSuccess: (...args) => {
      invalidate();
      options.onSuccess?.(...args);
    },
    ...options,
  });
}

// --- Webhook-driven state reconciliation ----------------------------------

/** Where the pending plan is parked across the redirect to Stripe and back. */
const PENDING_KEY = 'billing:pendingCheckout';

/**
 * Records what the user is buying, just before leaving for Stripe.
 *
 * Survives the full-page navigation to Stripe and back, which React state
 * cannot. `sessionStorage`, not `localStorage`: the intent belongs to this tab
 * and this checkout, and must not leak into a later session.
 */
export function rememberPendingCheckout({ planId, interval }) {
  try {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ planId, interval, startedAt: Date.now() })
    );
  } catch {
    // Private-browsing modes can refuse storage. The reconciler falls back to
    // "wait for any change", which is slightly less precise but still works.
  }
}

export function readPendingCheckout() {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Older than 30 minutes is an abandoned attempt, not a pending one.
    if (Date.now() - (parsed.startedAt ?? 0) > 30 * 60_000) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingCheckout() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing to clean up */
  }
}

/** How long to poll before falling back, and before giving up. */
const SYNC_FALLBACK_AFTER_MS = 8000;
const GIVE_UP_AFTER_MS = 45000;

/**
 * Bridges the gap between "Stripe redirected the user back" and "the webhook
 * has been processed".
 *
 * This is the piece that makes a webhook-driven change feel seamless. Checkout
 * completes on Stripe's servers, so the browser returns to a UI whose local
 * state is still the OLD plan — the real update arrives moments later, out of
 * band, as `checkout.session.completed`. Rather than showing a stale plan (or
 * lying and showing the new one before it is real), the UI enters an explicit
 * "confirming" state and watches the server until the truth catches up.
 *
 * The escalation is deliberate:
 *   0–8s   poll `/subscription` — the happy path, webhook lands in ~1–2s
 *   8s     call `/sync` once, which pulls state straight from Stripe. Covers
 *          local development with no tunnel, and events that failed delivery.
 *   45s    stop, and surface a manual "Refresh" rather than spinning forever.
 *
 * @param {{ enabled: boolean, expected: {planId?: string}|null,
 *           onSettled?: (info: {planId: string}) => void }} args
 */
export function useCheckoutReconciliation({ enabled, expected, onSettled }) {
  const [phase, setPhase] = useState(enabled ? 'confirming' : 'idle');
  const startedAt = useRef(Date.now());
  const syncAttempted = useRef(false);
  const settled = useRef(false);

  const sync = useSyncBilling();
  const syncMutate = sync.mutate;

  const query = useSubscription({
    pollWhile: phase === 'confirming',
    intervalMs: 2000,
  });

  const data = query.data;

  useEffect(() => {
    if (!enabled) {
      setPhase('idle');
      return;
    }
    if (phase !== 'confirming' || settled.current) return;

    const planId = data?.subscription?.planId;
    const entitled = data?.subscription?.entitled;

    // Settled when the subscription is live AND — if we know what was bought —
    // it is the plan that was bought. Without that second check, an existing
    // subscriber changing plans would see "done" against their old plan.
    const matches =
      entitled && (!expected?.planId || planId === expected.planId);

    if (matches) {
      settled.current = true;
      setPhase('done');
      clearPendingCheckout();
      onSettled?.({ planId });
      return;
    }

    const elapsed = Date.now() - startedAt.current;

    if (elapsed > GIVE_UP_AFTER_MS) {
      setPhase('timeout');
      return;
    }

    if (elapsed > SYNC_FALLBACK_AFTER_MS && !syncAttempted.current) {
      syncAttempted.current = true;
      syncMutate();
    }
  }, [enabled, phase, data, expected?.planId, onSettled, syncMutate]);

  /** Manual retry offered once polling has given up. */
  const retry = useCallback(() => {
    startedAt.current = Date.now();
    syncAttempted.current = false;
    settled.current = false;
    setPhase('confirming');
    syncMutate();
  }, [syncMutate]);

  return {
    /** 'idle' | 'confirming' | 'done' | 'timeout' */
    phase,
    subscription: data?.subscription ?? null,
    plan: data?.plan ?? null,
    retry,
    isSyncing: sync.isPending,
  };
}
