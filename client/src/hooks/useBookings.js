import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { bookingApi } from '../lib/bookingApi.js';

/**
 * TanStack Query bindings for the Booking API.
 *
 * Note `retry: false` throughout: the transport in `bookingClient.js` already
 * retries idempotent requests three times with jittered backoff. Letting Query
 * retry as well would multiply the attempts (3 x 3) and mask real failures.
 */

export const bookingKeys = {
  all: ['bookings'],
  lists: () => ['bookings', 'list'],
  list: (params) => ['bookings', 'list', params],
  details: () => ['bookings', 'detail'],
  detail: (id) => ['bookings', 'detail', id],
};

export function useBookingList(params, options = {}) {
  return useQuery({
    queryKey: bookingKeys.list(params),
    queryFn: ({ signal }) => bookingApi.list(params, { signal }),
    // Keep the previous page/range on screen while the next one loads, so
    // paging and calendar navigation do not flash an empty view.
    placeholderData: keepPreviousData,
    retry: false,
    ...options,
  });
}

export function useBooking(id, options = {}) {
  return useQuery({
    queryKey: bookingKeys.detail(id),
    queryFn: ({ signal }) => bookingApi.get(id, { signal }),
    enabled: Boolean(id),
    retry: false,
    ...options,
  });
}

export function useCreateBooking(options = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ payload, idempotencyKey }) =>
      bookingApi.create(payload, idempotencyKey),
    retry: false,
    onSuccess: (...args) => {
      qc.invalidateQueries({ queryKey: bookingKeys.lists() });
      options.onSuccess?.(...args);
    },
    ...options,
  });
}

export function useUpdateBooking(options = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, version }) => bookingApi.update(id, patch, version),
    retry: false,
    onSuccess: (data, variables, ctx) => {
      qc.invalidateQueries({ queryKey: bookingKeys.lists() });
      if (data?.booking) {
        qc.setQueryData(bookingKeys.detail(variables.id), data);
      }
      options.onSuccess?.(data, variables, ctx);
    },
    ...options,
  });
}

/**
 * Delete with an optimistic cache update and rollback.
 *
 * The row disappears immediately; if the request fails, every list snapshot
 * taken in `onMutate` is restored so the UI never silently loses a booking.
 */
export function useDeleteBooking(options = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => bookingApi.remove(id),
    retry: false,
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: bookingKeys.lists() });

      const snapshots = qc.getQueriesData({ queryKey: bookingKeys.lists() });

      qc.setQueriesData({ queryKey: bookingKeys.lists() }, (old) => {
        if (!old?.bookings) return old;
        const bookings = old.bookings.filter((b) => b.id !== id);
        if (bookings.length === old.bookings.length) return old;
        return { ...old, bookings, total: Math.max(0, (old.total ?? 0) - 1) };
      });

      return { snapshots };
    },
    onError: (err, variables, context) => {
      for (const [key, data] of context?.snapshots ?? []) {
        qc.setQueryData(key, data);
      }
      options.onError?.(err, variables, context);
    },
    onSettled: (data, err, variables, context) => {
      qc.invalidateQueries({ queryKey: bookingKeys.lists() });
      options.onSettled?.(data, err, variables, context);
    },
    ...options,
  });
}
