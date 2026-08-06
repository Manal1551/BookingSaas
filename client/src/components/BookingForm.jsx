import { forwardRef, useEffect, useRef, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';

import Modal from './Modal.jsx';
import {
  createBookingInputSchema,
  updateBookingInputSchema,
  BOOKING_STATUSES,
  SLOT_MINUTES,
  MAX_NOTES_LENGTH,
} from '@shared/booking.schemas.js';
import { bookingApi, changedFields, describeError, ERROR_CODES } from '../lib/bookingApi.js';
import { BILLING_ERROR_CODES } from '../lib/billingApi.js';
import { useCreateBooking, useUpdateBooking } from '../hooks/useBookings.js';
import { toDatetimeLocal, fromDatetimeLocal } from '../lib/datetime.js';

/**
 * Create / edit a booking.
 *
 * Client-side validation uses the SAME Zod schemas the server validates with,
 * imported through the `@shared` alias — so the rules cannot drift. Form state
 * is held in the API's own wire format (ISO 8601 strings) rather than the
 * browser's `datetime-local` format, which is what lets the create schema
 * validate the form object directly with no translation layer.
 *
 * Props:
 *   mode: 'create' | 'edit'
 *   booking: existing booking (edit) or a { startAt, endAt } prefill (create)
 *   onClose(): dismiss
 *   onSaved(booking): after a successful create/update
 *   onStale(): the booking changed underneath an edit
 */
export default function BookingForm({ mode = 'create', booking, onClose, onSaved, onStale }) {
  const isEdit = mode === 'edit';
  const [formError, setFormError] = useState(null);

  /**
   * ONE idempotency key per form session — the whole point of the exercise.
   * It is reused across every retry of this submission (network blips, 5xx,
   * an impatient double-click), so the server can recognise them as the same
   * intent. It is only regenerated after a successful submit or a reset.
   */
  const idempotencyKeyRef = useRef(null);
  if (idempotencyKeyRef.current === null) idempotencyKeyRef.current = newIdempotencyKey();

  const defaultValues = {
    customerName: booking?.customerName ?? '',
    customerEmail: booking?.customerEmail ?? '',
    serviceName: booking?.serviceName ?? '',
    resourceId: booking?.resourceId ?? '',
    startAt: booking?.startAt ? new Date(booking.startAt).toISOString() : '',
    endAt: booking?.endAt ? new Date(booking.endAt).toISOString() : '',
    notes: booking?.notes ?? '',
    status: booking?.status ?? 'pending',
  };

  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(isEdit ? updateBookingInputSchema : createBookingInputSchema),
    defaultValues,
    mode: 'onBlur',
  });

  const createMutation = useCreateBooking();
  const updateMutation = useUpdateBooking();
  const pending = isSubmitting || createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    setFocus('customerName');
  }, [setFocus]);

  /** Push server-side `details[]` back onto the matching form fields. */
  function applyServerFieldErrors(err) {
    const fields = err.fieldErrors?.() ?? {};
    let mapped = false;
    for (const [field, message] of Object.entries(fields)) {
      if (field in defaultValues) {
        setError(field, { type: 'server', message });
        mapped = true;
      }
    }
    return mapped;
  }

  async function onSubmit(values) {
    setFormError(null);

    try {
      if (isEdit) {
        // Send ONLY what actually changed, plus the version we loaded.
        const patch = changedFields(defaultValues, values);
        if (Object.keys(patch).length === 0) {
          onClose?.();
          return;
        }
        const result = await updateMutation.mutateAsync({
          id: booking.id,
          patch,
          version: booking.version,
        });
        onSaved?.(result.booking);
      } else {
        const result = await createMutation.mutateAsync({
          payload: values,
          idempotencyKey: idempotencyKeyRef.current,
        });
        // Success: this key is spent — a further booking is a new intent.
        idempotencyKeyRef.current = newIdempotencyKey();
        onSaved?.(result.booking);
      }
    } catch (err) {
      handleSubmitError(err);
    }
  }

  function handleSubmitError(err) {
    const { message, requestId, code } = describeError(err);

    if (code === ERROR_CODES.STALE_RESOURCE) {
      onStale?.(err);
      return;
    }

    if (code === ERROR_CODES.IDEMPOTENCY_KEY_REUSE) {
      // The body changed after a completed attempt used this key. A new
      // intent needs a new key, otherwise every retry repeats the 409.
      idempotencyKeyRef.current = newIdempotencyKey();
      setFormError({
        message: 'This booking was already submitted with different details. Please review and submit again.',
        requestId,
      });
      return;
    }

    if (code === BILLING_ERROR_CODES.PLAN_LIMIT_EXCEEDED) {
      /**
       * Not a mistake by the user — the form is valid and resubmitting it
       * unchanged will fail identically. So it is rendered as an upsell with a
       * way forward rather than a validation error, and the idempotency key is
       * kept: after upgrading, the very same submission should go through.
       */
      const fields = err.fieldErrors?.() ?? {};
      if (fields.resourceId) {
        setError('resourceId', { type: 'server', message: fields.resourceId });
      }
      setFormError({ message, requestId, upgrade: true });
      return;
    }

    if (code === ERROR_CODES.BOOKING_CONFLICT) {
      setError('startAt', { type: 'server', message: 'This time overlaps an existing booking' });
      setFormError({ message, requestId });
      return;
    }

    const mapped = applyServerFieldErrors(err);
    setFormError(
      mapped
        ? { message: 'Please correct the highlighted fields.', requestId }
        : { message, requestId }
    );
  }

  return (
    <Modal
      open
      onClose={pending ? undefined : onClose}
      title={isEdit ? 'Edit booking' : 'New booking'}
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" form="booking-form" className="btn-primary" disabled={pending}>
            {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create booking'}
          </button>
        </>
      }
    >
      <form id="booking-form" className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        <Field
          id="customerName"
          label="Customer name"
          error={errors.customerName?.message}
          {...register('customerName')}
          autoComplete="name"
        />
        <Field
          id="customerEmail"
          label="Customer email"
          type="email"
          error={errors.customerEmail?.message}
          {...register('customerEmail')}
          autoComplete="email"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="serviceName"
            label="Service"
            error={errors.serviceName?.message}
            {...register('serviceName')}
          />
          <Field
            id="resourceId"
            label="Resource"
            placeholder="room-1"
            hint="Room, staff member or equipment being booked"
            error={errors.resourceId?.message}
            {...register('resourceId')}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <DateTimeField
            id="startAt"
            label="Start"
            control={control}
            name="startAt"
            error={errors.startAt?.message}
            hint={`Times snap to ${SLOT_MINUTES}-minute steps`}
          />
          <DateTimeField
            id="endAt"
            label="End"
            control={control}
            name="endAt"
            error={errors.endAt?.message}
          />
        </div>

        <div>
          <label className="label" htmlFor="status">
            Status
          </label>
          <select id="status" className="input capitalize" {...register('status')}>
            {BOOKING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {errors.status?.message && (
            <p className="mt-1 text-xs text-red-600">{errors.status.message}</p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="notes">
            Notes <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="notes"
            className="input min-h-[80px] resize-y"
            maxLength={MAX_NOTES_LENGTH}
            aria-invalid={Boolean(errors.notes)}
            {...register('notes')}
          />
          {errors.notes?.message && (
            <p className="mt-1 text-xs text-red-600">{errors.notes.message}</p>
          )}
        </div>

        {formError && (
          <div
            role="alert"
            className={[
              'rounded-lg px-3 py-2 text-sm',
              // Amber, not red: hitting a plan limit is a state to resolve, not
              // a mistake to correct.
              formError.upgrade
                ? 'bg-amber-50 text-amber-900'
                : 'bg-red-50 text-red-700',
            ].join(' ')}
          >
            <p>{formError.message}</p>
            {formError.upgrade && (
              <Link
                to="/dashboard/plans"
                className="mt-2 inline-flex font-semibold underline underline-offset-2"
              >
                View plans
              </Link>
            )}
            {formError.requestId && (
              <p
                className={[
                  'mt-1 font-mono text-xs',
                  formError.upgrade ? 'text-amber-600' : 'text-red-500',
                ].join(' ')}
              >
                Reference: {formError.requestId}
              </p>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Bridges the ISO-string form value to a `datetime-local` input. */
function DateTimeField({ id, label, control, name, error, hint }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <div>
          <label className="label" htmlFor={id}>
            {label}
          </label>
          <input
            id={id}
            type="datetime-local"
            className="input"
            // 300s steps keep the picker on the 5-minute grid the API requires.
            step={SLOT_MINUTES * 60}
            value={toDatetimeLocal(field.value)}
            onChange={(e) => field.onChange(fromDatetimeLocal(e.target.value))}
            onBlur={field.onBlur}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          {error ? (
            <p id={`${id}-error`} className="mt-1 text-xs text-red-600">
              {error}
            </p>
          ) : hint ? (
            <p className="mt-1 text-xs text-slate-400">{hint}</p>
          ) : null}
        </div>
      )}
    />
  );
}

// forwardRef so react-hook-form's `register()` ref reaches the real <input>.
const Field = forwardRef(function Field({ id, label, error, hint, ...props }, ref) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={ref}
        className="input"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
});

function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts: a v4-shaped UUID the server will accept.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
