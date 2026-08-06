import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Pricing from './Pricing.jsx';
import { ToastProvider } from '../components/Toast.jsx';

/**
 * Component tests for the pricing page and the checkout hand-off.
 *
 * `fetch` is stubbed rather than the api module, so the real transport runs —
 * which is what makes the Idempotency-Key assertion meaningful. The auth
 * context is mocked because the page only reads a role from it, and standing
 * up the real provider would mean stubbing `/api/auth/me` for no extra
 * coverage.
 */

const mockAuth = { user: { name: 'Ada', role: 'owner' }, tenant: { name: 'Acme' } };
vi.mock('../components/TenantContext.jsx', () => ({
  useAuth: () => mockAuth,
}));

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

const PLANS_PAYLOAD = {
  currentPlanId: 'free',
  currentInterval: null,
  billingEnabled: true,
  subscription: null,
  plans: [
    {
      id: 'free',
      name: 'Free',
      tagline: 'Start here.',
      popular: false,
      currency: 'usd',
      prices: {
        monthly: { amount: 0, available: true },
        yearly: { amount: 0, available: true },
      },
      limits: { bookingsPerMonth: 50 },
      features: ['Up to 50 bookings per month'],
      current: true,
      actions: { monthly: 'current', yearly: 'current' },
    },
    {
      id: 'pro',
      name: 'Pro',
      tagline: 'For growing teams.',
      popular: true,
      currency: 'usd',
      prices: {
        monthly: { amount: 2900, available: true },
        yearly: { amount: 29000, available: true },
      },
      limits: { bookingsPerMonth: 2000 },
      features: ['Up to 2,000 bookings per month'],
      current: false,
      actions: { monthly: 'upgrade', yearly: 'upgrade' },
    },
    {
      id: 'business',
      name: 'Business',
      tagline: 'Unlimited scale.',
      popular: false,
      currency: 'usd',
      prices: {
        monthly: { amount: 9900, available: false },
        yearly: { amount: 99000, available: false },
      },
      limits: { bookingsPerMonth: null },
      features: ['Unlimited bookings'],
      current: false,
      actions: { monthly: 'upgrade', yearly: 'upgrade' },
    },
  ],
};

function renderPricing() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>
          <Pricing />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

let assignSpy;

beforeEach(() => {
  mockAuth.user = { name: 'Ada', role: 'owner' };

  // jsdom refuses real navigation; the page's hand-off to Stripe is a
  // `location.assign`, so that is what we observe.
  assignSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign: assignSpy, hostname: 'acme.app.local', protocol: 'http:' },
  });

  if (!globalThis.crypto?.randomUUID) {
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => 'test-uuid-0000' };
  }
  sessionStorage.clear();
});

describe('Pricing page', () => {
  it('renders the catalog with the current plan marked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PLANS_PAYLOAD))
    );

    renderPricing();

    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('Business')).toBeInTheDocument();
    expect(screen.getByText('Your plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Current plan' })).toBeDisabled();
  });

  it('switches prices when the billing interval changes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PLANS_PAYLOAD))
    );

    renderPricing();

    expect(await screen.findByText('$29')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /yearly/i }));

    expect(await screen.findByText('$290')).toBeInTheDocument();
    // The annual figure alone is hard to compare — the monthly equivalent is
    // what the page promises to show alongside it.
    expect(screen.getByText(/\$24\.17\/mo billed yearly/)).toBeInTheDocument();
  });

  it('offers no button for a plan with no configured price', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PLANS_PAYLOAD))
    );

    renderPricing();

    // Business has `available: false` — it must not render a button that would
    // fail the moment it is pressed.
    expect(await screen.findByRole('button', { name: 'Contact sales' })).toBeDisabled();
  });

  it('sends an Idempotency-Key and redirects to Stripe on upgrade', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/api/billing/plans')) {
        return jsonResponse(200, PLANS_PAYLOAD);
      }
      return jsonResponse(201, {
        checkout: { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPricing();

    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade' }));

    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_123')
    );

    const checkoutCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/billing/checkout')
    );
    expect(checkoutCall).toBeTruthy();
    // Without this header a double-click could open two Stripe sessions.
    expect(checkoutCall[1].headers['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(checkoutCall[1].body)).toEqual({
      planId: 'pro',
      interval: 'monthly',
    });
  });

  it('remembers the pending plan across the redirect to Stripe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).includes('/api/billing/plans')
          ? jsonResponse(200, PLANS_PAYLOAD)
          : jsonResponse(201, { checkout: { id: 'cs_1', url: 'https://checkout.stripe.com/x' } })
      )
    );

    renderPricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade' }));

    await waitFor(() => expect(assignSpy).toHaveBeenCalled());

    // React state cannot survive a full-page redirect; this is what lets the
    // page we return to know which plan to wait for.
    const pending = JSON.parse(sessionStorage.getItem('billing:pendingCheckout'));
    expect(pending.planId).toBe('pro');
    expect(pending.interval).toBe('monthly');
  });

  it('lets an existing subscriber switch from monthly to yearly', async () => {
    // Someone on Pro MONTHLY. Toggling to yearly must offer a real action —
    // treating "same plan id" as "current" would make annual billing
    // unreachable, which is the switch a business most wants to offer.
    const onProMonthly = {
      ...PLANS_PAYLOAD,
      currentPlanId: 'pro',
      currentInterval: 'monthly',
      subscription: { planId: 'pro', interval: 'monthly', entitled: true, status: 'active' },
      plans: PLANS_PAYLOAD.plans.map((p) =>
        p.id === 'pro'
          ? {
              ...p,
              current: true,
              actions: { monthly: 'current', yearly: 'switch_interval' },
            }
          : p.id === 'free'
            ? { ...p, current: false, actions: { monthly: 'downgrade', yearly: 'downgrade' } }
            : p
      ),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, onProMonthly))
    );

    renderPricing();

    // On monthly it is genuinely the current position.
    expect(await screen.findByRole('button', { name: 'Current plan' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /yearly/i }));

    const switchBtn = await screen.findByRole('button', { name: 'Switch to yearly' });
    expect(switchBtn).toBeEnabled();
    // The badge names the interval actually held, so it does not read as a
    // contradiction beside a "Switch to yearly" button.
    expect(screen.getByText('Your plan · monthly')).toBeInTheDocument();
  });

  it('treats moving to Free as a cancellation, not a dead end', async () => {
    const onPro = {
      ...PLANS_PAYLOAD,
      currentPlanId: 'pro',
      currentInterval: 'monthly',
      subscription: {
        planId: 'pro',
        interval: 'monthly',
        entitled: true,
        status: 'active',
        currentPeriodEnd: '2026-09-01T00:00:00.000Z',
      },
      plans: PLANS_PAYLOAD.plans.map((p) =>
        p.id === 'free'
          ? { ...p, current: false, actions: { monthly: 'downgrade', yearly: 'downgrade' } }
          : p.id === 'pro'
            ? { ...p, current: true, actions: { monthly: 'current', yearly: 'switch_interval' } }
            : p
      ),
    };

    const fetchMock = vi.fn(async (url) =>
      String(url).includes('/api/billing/cancel')
        ? jsonResponse(200, {
            cancellation: { cancelAtPeriodEnd: true, accessUntil: '2026-09-01T00:00:00.000Z' },
          })
        : jsonResponse(200, onPro)
    );
    vi.stubGlobal('fetch', fetchMock);

    renderPricing();

    fireEvent.click(await screen.findByRole('button', { name: 'Downgrade' }));

    // Free is not a purchasable price — the button confirms a cancellation
    // rather than telling the user to go find it on another page.
    expect(await screen.findByText('Move down to Free?')).toBeInTheDocument();
    expect(screen.getByText(/keep every Pro feature until then/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move to Free' }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes('/api/billing/cancel'))
      ).toBe(true)
    );
  });

  it('does not let a member change the plan', async () => {
    mockAuth.user = { name: 'Bob', role: 'member' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, PLANS_PAYLOAD))
    );

    renderPricing();

    expect(await screen.findByRole('button', { name: 'Upgrade' })).toBeDisabled();
    expect(
      screen.getAllByText('Only owners and admins can change the plan.').length
    ).toBeGreaterThan(0);
  });

  it('warns when billing is switched off on the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { ...PLANS_PAYLOAD, billingEnabled: false }))
    );

    renderPricing();

    expect(await screen.findByText(/Billing is not configured/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeDisabled();
  });

  it('surfaces a server error with its support reference', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) =>
        String(url).includes('/api/billing/plans')
          ? jsonResponse(200, PLANS_PAYLOAD)
          : jsonResponse(502, {
              error: {
                code: 'STRIPE_ERROR',
                message: 'Could not reach our payment provider.',
                requestId: 'req_abc123',
              },
            })
      )
    );

    renderPricing();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade' }));

    // The requestId is what a user quotes to support, so it is always shown.
    expect(await screen.findByText(/req_abc123/)).toBeInTheDocument();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
