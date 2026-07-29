import { useState } from 'react';
import Modal from './Modal.jsx';
import StatusBadge from './StatusBadge.jsx';
import { useToast } from './Toast.jsx';
import { useBooking, useDeleteBooking } from '../hooks/useBookings.js';
import { describeError } from '../lib/bookingApi.js';
import { formatDateTime, formatRange } from '../lib/datetime.js';

/**
 * Booking detail sheet: all fields, status, timestamps and the concurrency
 * version, plus edit and delete.
 *
 * The booking is re-fetched by id (seeded with the row the user clicked, so
 * there is no loading flash) — that way the version handed to the edit form is
 * always current, which is what keeps STALE_RESOURCE rare.
 */
export default function BookingDetail({ bookingId, initial, onClose, onEdit, onDeleted }) {
  const toast = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const query = useBooking(bookingId, {
    placeholderData: initial ? { booking: initial } : undefined,
  });
  const booking = query.data?.booking ?? initial;

  const deleteMutation = useDeleteBooking({
    onError: (err) => {
      // The optimistic removal has already been rolled back by the hook.
      const { message, requestId } = describeError(err);
      toast.error(requestId ? `${message} (ref ${requestId})` : message);
    },
    onSuccess: () => {
      toast.success('Booking deleted');
      onDeleted?.();
    },
  });

  if (!booking) {
    return (
      <Modal open onClose={onClose} title="Booking">
        <div className="space-y-3 py-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-slate-100" />
          ))}
        </div>
      </Modal>
    );
  }

  if (confirmingDelete) {
    return (
      <Modal
        open
        onClose={() => setConfirmingDelete(false)}
        title="Delete this booking?"
        maxWidth="max-w-md"
        footer={
          <>
            <button
              className="btn-ghost min-h-[44px]"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleteMutation.isPending}
            >
              Keep it
            </button>
            <button
              className="btn-primary min-h-[44px] !bg-red-600 hover:!bg-red-700"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate({ id: booking.id })}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete booking'}
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          <strong className="font-medium text-slate-900">{booking.serviceName}</strong> for{' '}
          {booking.customerName} on {formatRange(booking.startAt, booking.endAt)} will be
          removed. This cannot be undone.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Booking details"
      footer={
        <>
          <button
            className="btn-ghost min-h-[44px] !text-red-600 hover:!bg-red-50"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </button>
          <button className="btn-ghost min-h-[44px]" onClick={onClose}>
            Close
          </button>
          <button className="btn-primary min-h-[44px]" onClick={() => onEdit?.(booking)}>
            Edit
          </button>
        </>
      }
    >
      <dl className="space-y-4">
        <Row label="Status">
          <div className="flex items-center gap-2">
            <StatusBadge status={booking.status} />
            {query.isFetching && (
              <span className="text-xs text-slate-400">refreshing…</span>
            )}
          </div>
        </Row>
        <Row label="Service">{booking.serviceName}</Row>
        <Row label="Resource">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
            {booking.resourceId}
          </span>
        </Row>
        <Row label="When">{formatRange(booking.startAt, booking.endAt)}</Row>
        <Row label="Customer">
          <div>
            <div>{booking.customerName}</div>
            <a
              className="text-brand-600 hover:underline"
              href={`mailto:${booking.customerEmail}`}
            >
              {booking.customerEmail}
            </a>
          </div>
        </Row>
        {booking.notes && (
          <Row label="Notes">
            <p className="whitespace-pre-wrap">{booking.notes}</p>
          </Row>
        )}

        <div className="border-t border-slate-100 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            History
          </h3>
          <div className="mt-2 space-y-2">
            <Row label="Created" compact>
              {formatDateTime(booking.createdAt)}
            </Row>
            <Row label="Last updated" compact>
              {formatDateTime(booking.updatedAt)}
            </Row>
            <Row label="Revision" compact>
              <span className="font-mono text-xs">v{booking.version}</span>
            </Row>
          </div>
        </div>
      </dl>
    </Modal>
  );
}

function Row({ label, children, compact = false }) {
  return (
    <div className={compact ? 'flex justify-between gap-4 text-sm' : 'sm:flex sm:gap-4'}>
      <dt
        className={
          compact
            ? 'text-slate-400'
            : 'w-32 flex-shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400 sm:pt-0.5'
        }
      >
        {label}
      </dt>
      <dd className={compact ? 'text-slate-600' : 'mt-1 text-sm text-slate-700 sm:mt-0'}>
        {children}
      </dd>
    </div>
  );
}
