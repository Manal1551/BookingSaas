import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { resolveTenant } from '../middleware/resolveTenant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requestId } from '../middleware/requestId.js';
import { validate } from '../middleware/validate.js';
import { enforceBookingLimits } from '../middleware/enforcePlanLimits.js';
import {
  bookingErrorHandler,
  bookingNotFound,
} from '../middleware/bookingErrorHandler.js';
import {
  createBookingInputSchema,
  updateBookingInputSchema,
  listBookingsQuerySchema,
  bookingIdParamsSchema,
} from '../validation/booking.schemas.js';
import {
  listBookings,
  createBooking,
  getBooking,
  updateBooking,
  deleteBooking,
} from '../controllers/booking.controller.js';

const router = Router();

/**
 * The Booking API is self-contained: request ids, rate limiting, validation
 * and error formatting are all mounted HERE rather than on the app, so
 * `/api/bookings/*` speaks the Week 2 error envelope while every Week 1 route
 * keeps its original behaviour untouched.
 */

// Must run first — the rate limiter and the error handler both echo req.id.
router.use(requestId);

const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many booking requests. Please slow down and retry shortly.',
        requestId: req.id,
      },
    });
  },
});
router.use(bookingLimiter);

router.use(resolveTenant, requireAuth);

router.get('/', validate(listBookingsQuerySchema, 'query'), listBookings);
/**
 * The plan check sits AFTER validation and BEFORE the controller, so a
 * rejected request never reaches `withIdempotency` and therefore never burns
 * the caller's Idempotency-Key — they can upgrade and retry with the same one.
 * Creation is the only booking verb that is gated; reading, editing and
 * cancelling stay available to a tenant that is over its limit.
 */
router.post(
  '/',
  validate(createBookingInputSchema, 'body'),
  enforceBookingLimits,
  createBooking
);

router.get('/:id', validate(bookingIdParamsSchema, 'params'), getBooking);
router.patch(
  '/:id',
  validate(bookingIdParamsSchema, 'params'),
  validate(updateBookingInputSchema, 'body'),
  updateBooking
);
router.delete('/:id', validate(bookingIdParamsSchema, 'params'), deleteBooking);

// Unmatched booking paths and every thrown error leave in the same envelope.
router.use(bookingNotFound);
router.use(bookingErrorHandler);

export default router;
