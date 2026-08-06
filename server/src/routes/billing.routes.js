import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { resolveTenant } from '../middleware/resolveTenant.js';
import { requireAuth, requireRole } from '../middleware/requireAuth.js';
import { requestId } from '../middleware/requestId.js';
import { validate } from '../middleware/validate.js';
import { requireBilling } from '../services/stripe.js';
import { AppError } from '../utils/appError.js';
import { bookingErrorHandler } from '../middleware/bookingErrorHandler.js';
import {
  planSelectionSchema,
  planSelectionQuerySchema,
  listInvoicesQuerySchema,
} from '../validation/billing.schemas.js';
import {
  listPlans,
  getSubscription,
  listInvoices,
  getUsage,
  startCheckout,
  openPortal,
  previewChange,
  applyPlanChange,
  cancelPlan,
  resumePlan,
  syncBilling,
  attachBillingUser,
} from '../controllers/billing.controller.js';

const router = Router();

/**
 * Billing API, assembled the same way the Booking API was: request ids, rate
 * limiting, validation and the typed error envelope are mounted on THIS router
 * rather than on the app, so Week 1's flat `{ error: "message" }` routes are
 * untouched. `bookingErrorHandler` is reused verbatim — it already maps
 * AppError codes, HttpErrors from the Week 1 middleware, and Zod issues into
 * `{ error: { code, message, details, requestId } }`, and the billing codes
 * added to appError.js flow through it unchanged.
 */

router.use(requestId);

// Tighter than bookings: these endpoints reach a third-party API, and the
// mutating ones move money.
const billingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many billing requests. Please slow down and retry shortly.',
        requestId: req.id,
      },
    });
  },
});

const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many checkout attempts. Please wait a minute and try again.',
        requestId: req.id,
      },
    });
  },
});

router.use(billingLimiter);
router.use(resolveTenant, requireAuth);

/**
 * Anyone signed in may READ what plan the workspace is on — the header and the
 * pricing page show it to everyone. Only owners and admins may spend money or
 * change the plan.
 */
const requireBillingAdmin = [
  requireRole('owner', 'admin'),
  requireBilling,
  attachBillingUser,
];

// --- Reads ----------------------------------------------------------------
router.get('/plans', listPlans);
router.get('/subscription', getSubscription);
router.get('/invoices', validate(listInvoicesQuerySchema, 'query'), listInvoices);
router.get('/usage', getUsage);

// --- Commands -------------------------------------------------------------
router.post(
  '/checkout',
  checkoutLimiter,
  ...requireBillingAdmin,
  validate(planSelectionSchema, 'body'),
  startCheckout
);
router.post('/portal', ...requireBillingAdmin, openPortal);

router.get(
  '/preview',
  ...requireBillingAdmin,
  validate(planSelectionQuerySchema, 'query'),
  previewChange
);
router.post(
  '/change',
  ...requireBillingAdmin,
  validate(planSelectionSchema, 'body'),
  applyPlanChange
);

router.post('/cancel', ...requireBillingAdmin, cancelPlan);
router.post('/resume', ...requireBillingAdmin, resumePlan);
router.post('/sync', ...requireBillingAdmin, syncBilling);

// Same envelope on the way out, including for unmatched billing paths.
router.use((_req, _res, next) =>
  next(new AppError('NOT_FOUND', 'No such billing endpoint.'))
);
router.use(bookingErrorHandler);

export default router;
