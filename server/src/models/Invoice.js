import mongoose from 'mongoose';
import { tenantScopePlugin } from '../middleware/tenantScopePlugin.js';
import { PLAN_IDS } from '../config/plans.js';

/**
 * Local mirror of a Stripe Invoice, written by the invoice.* webhooks.
 *
 * The billing-history page reads this instead of calling Stripe on every page
 * load: history is append-only and rarely changes, so mirroring it makes the
 * page fast, paginatable with the same primitives as bookings, and readable
 * while Stripe is unreachable. The hosted-invoice and PDF URLs are stored
 * rather than proxied — they are Stripe-hosted, single-purpose, and expire on
 * Stripe's own schedule.
 */

export const INVOICE_STRIPE_ID_INDEX = 'invoice_stripe_id_unique';

const invoiceSchema = new mongoose.Schema(
  {
    // tenantId comes from tenantScopePlugin.
    stripeInvoiceId: { type: String, required: true, trim: true },
    stripeCustomerId: { type: String, required: true, trim: true },
    stripeSubscriptionId: { type: String, default: null },

    number: { type: String, default: null }, // human-facing "ACME-0001"
    status: {
      type: String,
      enum: ['draft', 'open', 'paid', 'uncollectible', 'void'],
      required: true,
    },

    // Money is stored in the smallest currency unit, exactly as Stripe sends
    // it — never as a float.
    amountDue: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    amountRemaining: { type: Number, default: 0 },
    currency: { type: String, default: 'usd' },

    planId: { type: String, enum: [...PLAN_IDS, null], default: null },
    description: { type: String, default: null },

    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },

    hostedInvoiceUrl: { type: String, default: null },
    invoicePdfUrl: { type: String, default: null },

    // Same out-of-order guard as Subscription: an invoice.paid that overtakes
    // its own invoice.payment_failed must not be undone by the straggler.
    lastEventAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'invoices' }
);

invoiceSchema.index(
  { tenantId: 1, stripeInvoiceId: 1 },
  { unique: true, name: INVOICE_STRIPE_ID_INDEX }
);
// Billing history is always read newest-first for one tenant.
invoiceSchema.index({ tenantId: 1, issuedAt: -1 });

invoiceSchema.plugin(tenantScopePlugin);

export const Invoice =
  mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
