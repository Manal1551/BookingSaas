import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BookingForm from './BookingForm.jsx';

/**
 * Component tests for the create form: validation driven by the SHARED Zod
 * schema, and mapping of the server's `details[].path` back onto fields.
 *
 * `fetch` is stubbed rather than the api module, so the real transport runs —
 * that is what lets the idempotency-key assertions mean something.
 */

function renderForm(props = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BookingForm mode="create" onClose={() => {}} onSaved={() => {}} {...props} />
    </QueryClientProvider>
  );
}

/** A Response-alike for the transport's `res.text()` / `res.headers.get()`. */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
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
    target: { value: 'room-1' },
  });
  // Far enough ahead that the "must be in the future" rule always passes.
  fireEvent.change(screen.getByLabelText('Start'), {
    target: { value: '2099-01-01T10:00' },
  });
  fireEvent.change(screen.getByLabelText('End'), {
    target: { value: '2099-01-01T11:00' },
  });
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /create booking/i }));

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BookingForm — client-side validation', () => {
  it('blocks submission and shows the shared schema errors when empty', async () => {
    renderForm();
    submit();

    expect(await screen.findByText('Customer name is required')).toBeInTheDocument();
    expect(screen.getByText('Customer email is required')).toBeInTheDocument();
    expect(screen.getByText('Service is required')).toBeInTheDocument();
    expect(screen.getByText('Resource is required')).toBeInTheDocument();

    // Nothing may reach the network while the form is invalid.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an end time before the start time', async () => {
    renderForm();
    fillValidForm();
    fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '2099-01-01T09:00' },
    });
    submit();

    expect(await screen.findByText('End must be after start')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a booking in the past', async () => {
    renderForm();
    fillValidForm();
    fireEvent.change(screen.getByLabelText('Start'), {
      target: { value: '2020-01-01T10:00' },
    });
    fireEvent.change(screen.getByLabelText('End'), {
      target: { value: '2020-01-01T11:00' },
    });
    submit();

    expect(await screen.findByText('Must be in the future')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('BookingForm — server error mapping', () => {
  it('maps details[].path onto the matching field', async () => {
    fetch.mockResolvedValue(
      jsonResponse(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request failed validation.',
          requestId: 'req_test_123',
          details: [
            { path: 'body.customerEmail', message: 'That address is already blocked' },
          ],
        },
      })
    );

    renderForm();
    fillValidForm();
    submit();

    expect(
      await screen.findByText('That address is already blocked')
    ).toBeInTheDocument();
    expect(screen.getByText('Please correct the highlighted fields.')).toBeInTheDocument();
  });

  it('surfaces the requestId for support on an unmapped error', async () => {
    fetch.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'BOOKING_CONFLICT',
          message: 'That resource is already booked for part of this time range.',
          requestId: 'req_conflict_9',
        },
      })
    );

    renderForm();
    fillValidForm();
    submit();

    expect(await screen.findByText(/already booked/i)).toBeInTheDocument();
    expect(screen.getByText(/req_conflict_9/)).toBeInTheDocument();
  });
});

describe('BookingForm — idempotency', () => {
  it('sends an Idempotency-Key and reuses it across a retried submission', async () => {
    // First attempt fails at the network layer, so the transport retries.
    fetch
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'TypeError' }))
      .mockResolvedValue(
        jsonResponse(201, { booking: { id: 'b1', version: 0 } })
      );

    renderForm();
    fillValidForm();
    submit();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    const keys = fetch.mock.calls.map(([, init]) => init.headers['Idempotency-Key']);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(keys[1]).toBe(keys[0]);
  });

  it('disables the submit button while the request is in flight', async () => {
    let release;
    fetch.mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve(jsonResponse(201, { booking: { id: 'b1', version: 0 } }));
      })
    );

    renderForm();
    fillValidForm();
    submit();

    const button = screen.getByRole('button', { name: /saving/i });
    await waitFor(() => expect(button).toBeDisabled());

    // A second click cannot start a second request.
    fireEvent.click(button);
    expect(fetch).toHaveBeenCalledTimes(1);

    release();
  });
});
