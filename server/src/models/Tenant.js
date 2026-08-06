import mongoose from 'mongoose';
import { PLAN_IDS } from '../config/plans.js';

/**
 * Tenant is the root of the tenancy tree. It is NOT itself tenant-scoped
 * (there is no tenant "above" a tenant), so it does not use the scoping plugin.
 * The `slug` is the subdomain used to route requests.
 */
const tenantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [
        /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/,
        'slug must be lowercase alphanumeric/dashes, 1-50 chars',
      ],
    },
    /**
     * Denormalised entitlement level. Week 1 wrote 'free' | 'pro' here and the
     * dashboard header already renders it; Week 3 keeps those two ids meaning
     * exactly what they meant, adds 'business', and makes the field
     * webhook-driven for paid plans. The Subscription document is the detailed
     * record — this stays as the one field every entitlement check reads, so a
     * permission check never has to touch Stripe.
     */
    plan: { type: String, enum: PLAN_IDS, default: 'free' },

    /**
     * The Stripe Customer for this tenant, created lazily on first checkout.
     * Left UNSET (not null) until then — see the partial index below.
     */
    stripeCustomerId: { type: String },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

/**
 * One tenant per Stripe customer — but only among tenants that actually have
 * one.
 *
 * A `sparse` unique index is the obvious choice and the wrong one: sparse
 * skips only *missing* fields, so the moment a default writes an explicit
 * `null` every unbilled tenant collides on `null` and the second signup fails.
 * A partial index keyed on "is a string" is immune to that, and stays correct
 * whether the field is absent, null, or set.
 */
tenantSchema.index(
  { stripeCustomerId: 1 },
  {
    unique: true,
    partialFilterExpression: { stripeCustomerId: { $type: 'string' } },
    name: 'tenant_stripe_customer_unique',
  }
);

export const Tenant =
  mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
