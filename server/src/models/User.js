import mongoose from 'mongoose';
import { tenantScopePlugin } from '../middleware/tenantScopePlugin.js';

const userSchema = new mongoose.Schema(
  {
    // tenantId is added by tenantScopePlugin (required + indexed).
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'invalid email'],
    },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['owner', 'admin', 'member'],
      default: 'member',
    },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: false } }
);

// Same email may exist under different tenants, but must be unique within one.
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });

// Document-level tenant isolation.
userSchema.plugin(tenantScopePlugin);

// Never leak passwordHash if a document is serialized.
userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

export const User = mongoose.models.User || mongoose.model('User', userSchema);
