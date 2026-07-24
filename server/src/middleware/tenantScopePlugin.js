import mongoose from 'mongoose';
import { getTenantId } from '../utils/tenantContext.js';

/**
 * Mongoose plugin implementing document-level tenant isolation — the Mongo
 * equivalent of Postgres Row-Level Security, enforced in the application layer.
 *
 * Attach to every tenant-scoped schema:
 *   userSchema.plugin(tenantScopePlugin);
 *
 * What it does:
 *  1. Adds a required, indexed `tenantId` field.
 *  2. Query middleware: injects `tenantId` from the request-scoped
 *     AsyncLocalStorage context into every read/update/delete query, so a
 *     query can never accidentally cross tenants.
 *  3. Save middleware: stamps `tenantId` on new documents from context, and
 *     refuses to persist a document whose tenantId does not match context.
 *
 * If no tenant is in context, reads return nothing scoped (empty filter is NOT
 * allowed — we throw) and writes throw. This is fail-closed by design.
 */

// Query methods whose *filter* must be constrained to the current tenant.
const READ_WRITE_QUERIES = [
  'count',
  'countDocuments',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndRemove',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'update',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
];

export function tenantScopePlugin(schema) {
  schema.add({
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      required: true,
      index: true,
    },
  });

  // --- Read/update/delete queries: constrain filter to current tenant ---
  schema.pre(READ_WRITE_QUERIES, function tenantScopePreQuery() {
    // `this` is a Mongoose Query. Allow an explicit opt-out for trusted
    // system-level operations (e.g. resolveTenant looking up the Tenant, which
    // is itself not tenant-scoped, or maintenance scripts).
    if (this.getOptions()?.skipTenantScope) return;

    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error(
        `[tenantScope] Refusing to run "${this.op}" on "${this.model.modelName}" ` +
          'without a tenant in context. This query would leak across tenants.'
      );
    }

    // Merge, without letting caller-supplied tenantId override context.
    this.setQuery({ ...this.getQuery(), tenantId });
  });

  // --- Document writes: stamp/verify tenantId ---
  // Stamp on `validate` (which runs BEFORE `save`), so the required-tenantId
  // check sees the value. Also guard on `save` in case validation is skipped
  // (e.g. save({ validateBeforeSave: false })) — that keeps isolation intact.
  function stampTenant(next) {
    if (this.$locals?.skipTenantScope) return next();

    const tenantId = getTenantId();
    if (!tenantId) {
      return next(
        new Error(
          `[tenantScope] Refusing to write "${this.constructor.modelName}" ` +
            'without a tenant in context.'
        )
      );
    }

    if (!this.tenantId) {
      this.tenantId = tenantId;
    } else if (String(this.tenantId) !== String(tenantId)) {
      return next(
        new Error(
          '[tenantScope] Document tenantId does not match the tenant in ' +
            'context. Cross-tenant write blocked.'
        )
      );
    }
    return next();
  }

  schema.pre('validate', stampTenant);
  schema.pre('save', stampTenant);

  // --- insertMany(): stamp/verify each doc ---
  schema.pre('insertMany', function tenantScopePreInsertMany(next, docs) {
    const tenantId = getTenantId();
    if (!tenantId) {
      return next(
        new Error('[tenantScope] Refusing insertMany without a tenant in context.')
      );
    }
    for (const doc of docs) {
      if (!doc.tenantId) {
        doc.tenantId = tenantId;
      } else if (String(doc.tenantId) !== String(tenantId)) {
        return next(
          new Error('[tenantScope] insertMany contained a cross-tenant document.')
        );
      }
    }
    return next();
  });
}
