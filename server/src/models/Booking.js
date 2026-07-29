import mongoose from 'mongoose';
import { tenantScopePlugin } from '../middleware/tenantScopePlugin.js';
import { BOOKING_STATUSES, MAX_NOTES_LENGTH } from '../validation/booking.schemas.js';

export const SLOT_INDEX_NAME = 'booking_slot_unique';

/**
 * Statuses that actually hold the slot. A cancelled booking releases its time
 * so the slot can be rebooked — which is why the overlap index is *partial*.
 */
export const ACTIVE_STATUSES = ['pending', 'confirmed', 'completed'];

const bookingSchema = new mongoose.Schema(
  {
    customerName: { type: String, required: true, trim: true, maxlength: 120 },
    customerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 200,
    },
    serviceName: { type: String, required: true, trim: true, maxlength: 160 },
    // What is being booked (room / staff member / equipment). Free-form
    // identifier — Week 2 does not introduce a Resource collection.
    resourceId: { type: String, required: true, trim: true, maxlength: 64 },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    notes: { type: String, trim: true, maxlength: MAX_NOTES_LENGTH, default: '' },
    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: 'pending',
    },
    /**
     * The 5-minute grid slots this booking occupies (see utils/slots.js).
     * Derived, never client-supplied. Empty for cancelled bookings.
     */
    slotKeys: { type: [Number], default: [] },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' } }
);

/**
 * DB-LEVEL double-booking prevention.
 *
 * Mongo has no range-exclusion constraint (Postgres would use
 * `EXCLUDE USING gist (resource_id WITH =, tstzrange(start, end) WITH &&)`),
 * so overlap is reduced to uniqueness over discrete slots: `slotKeys` is an
 * array, making this a multikey index, and uniqueness across multikey entries
 * means no two bookings for the same resource can share any slot.
 *
 * `partialFilterExpression` keeps cancelled bookings out of the index
 * entirely, freeing their slots. ($ne is unsupported in partial filters, so
 * the active statuses are listed with $in.)
 */
bookingSchema.index(
  { tenantId: 1, resourceId: 1, slotKeys: 1 },
  {
    unique: true,
    name: SLOT_INDEX_NAME,
    partialFilterExpression: { status: { $in: ACTIVE_STATUSES } },
  }
);

// Calendar range queries (?from&to) and the default sort.
bookingSchema.index({ tenantId: 1, startAt: 1 });

bookingSchema.plugin(tenantScopePlugin);

export const Booking = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);
