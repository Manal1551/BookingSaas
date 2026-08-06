import { Tenant } from '../models/Tenant.js';
import { assertCanCreateBooking } from '../services/entitlements.js';

/**
 * Blocks a booking creation that would exceed the tenant's plan.
 *
 * Mounted on `POST /api/bookings` ONLY — deliberately not on GET, PATCH or
 * DELETE. A tenant that is over its limit (or has just downgraded) must still
 * be able to read, edit and cancel what it already has; the plan caps how much
 * you can create, not whether you can manage what exists. That also makes a
 * downgrade always safe to apply, with no data hidden or destroyed.
 *
 * It runs AFTER `validate(createBookingInputSchema)`, so `req.body` is already
 * parsed and `resourceId` can be trusted. Errors leave through the booking
 * router's own error handler in the usual envelope, with code
 * `PLAN_LIMIT_EXCEEDED` and HTTP 402.
 *
 * The tenant is re-read rather than taken from `req.tenant`, because
 * `resolveTenant` cached that document at the start of the request and a
 * webhook may have upgraded the plan in the meantime — the common case being a
 * user who hits the limit, upgrades in another tab, and retries.
 */
export async function enforceBookingLimits(req, _res, next) {
  try {
    const tenant = await Tenant.findById(req.tenant._id).lean();

    await assertCanCreateBooking({
      planId: tenant?.plan ?? 'free',
      resourceId: req.body?.resourceId,
    });

    next();
  } catch (err) {
    next(err);
  }
}
