import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import UsageMeters from './UsageMeters.jsx';
import BookingForm from './BookingForm.jsx';

/**
 * The plan-limit surface: the meters that show how close a workspace is, and
 * what the booking form does when the server says "no room left".
 *
 * The behaviour worth protecting is that a limit is presented as a state to
 * resolve, not a mistake to correct — an upsell with a way forward, never a
 * red validation error the user cannot act on.
 */

function meter(used, limit) {
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    exceeded: limit !== null && used >= limit,
  };
}

function usagePayload(overrides = {}) {
  return {
    planId: 'free',
    planName: 'Free',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    usage: {
      bookingsPerMonth: meter(12, 50),
      teamMembers: meter(1, 2),
      resources: meter(1, 1),
      ...overrides,
    },
  };
}

const renderMeters = (props) =>
  render(
    <MemoryRouter>
      <UsageMeters {...props} />
    </MemoryRouter>
  );

describe('UsageMeters', () => {
  it('shows the exact count alongside the bar', () => {
    renderMeters({ data: usagePayload() });

    // The number is what answers "can I create three more?" — the bar alone
    // cannot.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('/ 50')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Bookings this month' })
    ).toHaveAttribute('aria-valuemax', '50');
  });

  it('renders unlimited limits without a progress bar', () => {
    renderMeters({
      data: {
        ...usagePayload(),
        planName: 'Business',
        usage: {
          bookingsPerMonth: meter(4200, null),
          teamMembers: meter(30, null),
          resources: meter(90, null),
        },
      },
    });

    expect(screen.getAllByText('· unlimited').length).toBe(3);
    // A bar with no end is noise.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('warns before the wall, not at it', () => {
    renderMeters({ data: usagePayload({ bookingsPerMonth: meter(45, 50) }) });

    expect(screen.getByText('5 bookings left on this plan.')).toBeInTheDocument();
  });

  it('offers an upgrade and reassures about data when a limit is hit', () => {
    renderMeters({ data: usagePayload({ bookingsPerMonth: meter(50, 50) }) });

    expect(screen.getByRole('link', { name: 'Upgrade' })).toHaveAttribute(
      'href',
      '/dashboard/plans'
    );
    // "I hit a limit" reads as "am I about to lose my data?" — answer it.
    expect(screen.getByText(/Nothing is deleted or hidden/)).toBeInTheDocument();
  });

  it('reports an overage honestly rather than clamping it', () => {
    // A tenant that downgraded while over its limit.
    renderMeters({ data: usagePayload({ bookingsPerMonth: meter(73, 50) }) });

    // The bar is clamped to 100%, but the NUMBER must still say 73 — clamping
    // the count would hide the size of the overage from the person fixing it.
    expect(screen.getByText('73')).toBeInTheDocument();
    expect(screen.getByText('/ 50')).toBeInTheDocument();
    // Both bookings and resources are over in this fixture, hence getAll.
    expect(screen.getAllByText(/Limit reached/).length).toBe(2);
  });
});

// --- The form's reaction ----------------------------------------------------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function renderForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BookingForm mode="create" onClose={() => {}} onSaved={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function fillValidForm() {
  fireEvent.change(screen.getByLabelText('Customer name'), {
    target: { value: 'Ada Lovelace' },
  });
  fireEvent.change(screen.getByLabelText('Customer email'), {
    target: { value: 'ada@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Service'), {
    target: { value: 'Design call' },
  });
  fireEvent.change(screen.getByLabelText('Resource'), {
    target: { value: 'room-2' },
  });

  const start = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(0);
  const iso = (d) => d.toISOString().slice(0, 16);
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: iso(start) } });
  fireEvent.change(screen.getByLabelText('End'), {
    target: { value: iso(new Date(start.getTime() + 3600 * 1000)) },
  });
}

const LIMIT_ERROR = {
  error: {
    code: 'PLAN_LIMIT_EXCEEDED',
    message:
      'The Free plan covers 1 bookable resource, and you are already using 1. ' +
      'Upgrade to add "room-2".',
    details: [{ path: 'body.resourceId', message: 'Not available on the Free plan' }],
    requestId: 'req_limit_1',
  },
};

beforeEach(() => {
  if (!globalThis.crypto?.randomUUID) {
    globalThis.crypto = { ...globalThis.crypto, randomUUID: () => 'test-uuid-0000' };
  }
});

describe('BookingForm on a plan limit', () => {
  it('presents an upgrade path instead of a dead-end error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(402, LIMIT_ERROR))
    );

    renderForm();
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /create booking/i }));

    expect(await screen.findByText(/Upgrade to add "room-2"/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute(
      'href',
      '/dashboard/plans'
    );
    // The support reference is still there — it is a real server response.
    expect(screen.getByText(/req_limit_1/)).toBeInTheDocument();
  });

  it('reuses the same Idempotency-Key on retry, since nothing was created', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(402, LIMIT_ERROR))
      .mockResolvedValueOnce(jsonResponse(201, { booking: { id: 'b1', version: 0 } }));
    vi.stubGlobal('fetch', fetchMock);

    renderForm();
    fillValidForm();

    const submit = screen.getByRole('button', { name: /create booking/i });
    fireEvent.click(submit);
    await screen.findByText(/Upgrade to add/);

    // Simulates upgrading in another tab and resubmitting the same form.
    fireEvent.click(submit);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const keyOf = (call) => call[1].headers['Idempotency-Key'];
    expect(keyOf(fetchMock.mock.calls[0])).toBe(keyOf(fetchMock.mock.calls[1]));
  });
});
