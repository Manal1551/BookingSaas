import mongoose from 'mongoose';

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
    plan: { type: String, enum: ['free', 'pro'], default: 'free' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

export const Tenant =
  mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
