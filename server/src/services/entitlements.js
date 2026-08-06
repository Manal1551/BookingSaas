import { Booking } from '../models/Booking.js';
import { User } from '../models/User.js';
import { getPlan } from '../config/plans.js';
import { AppError } from '../utils/appError.js';

/**
 * Plan-limit enforcement.
 *
 * `Tenant.plan` is the only input. It is DERIVED by the webhook pipeline from
 * the subscription state (see services/billingSync.js), so an entitlement
 * check is a plain field read — no Stripe call, no subscription join, nothing
 * that could time out on the request path. That is the whole reason the plan
 * is denormalised onto the tenant.
 *
 * Two rules the checks below follow:
 *
 *  1. WRITES ARE BLOCKED, READS NEVER ARE. Going over a limit — or dropping to
 *     a smaller plan while over it — must never hide data a customer already
 *     has. Existing bookings stay listable, editable and cancellable; only
 *     *creating more* stops. Downgrades are therefore always safe to apply.
 *  2. THE LIMIT IS CHECKED AGAINST WHAT EXISTS, not against a counter. There is
 *     no usage column to drift out of sync, get double-incremented on a retry,
 *     or need backfilling. Counting is cheap here because every count is an
 *     indexed, tenant-scoped query.
 */

/** Calendar-month window (UTC) that `bookingsPerMonth` is measured over. */
export function currentUsagePeriod(now = new Date()) {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0)
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  );
  return { start, end };
}

/**
 * Current usage for the tenant in context.
 *
 * MUST be called inside a tenant context — every query here is scoped by the
 * plugin, which fails closed without one.
 *
 * `bookingsThisMonth` counts bookings *created* in the window, including ones
 * later cancelled: creating and cancelling repeatedly is still usage, and not
 * counting it would make the limit trivially bypassable.
 */
export async function getUsage() {
  const { start, end } = currentUsagePeriod();

  const [bookingsThisMonth, teamMembers, resourceIds] = await Promise.all([
    Booking.countDocuments({ createdAt: { $gte: start, $lt: end } }),
    User.countDocuments({}),
    // Resources are not a collection in this app — a "resource" is any
    // distinct resourceId that has ever been booked. Distinct over the
    // tenant-scoped index is exact and cheap at this scale.
    Booking.distinct('resourceId'),
  ]);

  return {
    bookingsThisMonth,
    teamMembers,
    resources: resourceIds.length,
    resourceIds,
    periodStart: start,
    periodEnd: end,
  };
}

/** `Infinity` limits are unlimited; JSON carries them as null. */
const isUnlimited = (limit) => !Number.isFinite(limit);

/**
 * Usage + limits + headroom for one tenant, ready for the UI's meters.
 * Read-only: never throws for being over a limit.
 */
export async function describeEntitlements(planId) {
  const plan = getPlan(planId) ?? getPlan('free');
  const usage = await getUsage();

  const meter = (used, limit) => ({
    used,
    limit: isUnlimited(limit) ? null : limit,
    remaining: isUnlimited(limit) ? null : Math.max(0, limit - used),
    // Over, not just at: a tenant that downgraded may legitimately sit above a
    // limit it never chose to exceed.
    exceeded: !isUnlimited(limit) && used >= limit,
  });

  return {
    planId: plan.id,
    planName: plan.name,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    usage: {
      bookingsPerMonth: meter(usage.bookingsThisMonth, plan.limits.bookingsPerMonth),
      teamMembers: meter(usage.teamMembers, plan.limits.teamMembers),
      resources: meter(usage.resources, plan.limits.resources),
    },
  };
}

/** The message a limit produces. Names the plan and what to do about it. */
function limitError(planName, { message, path }) {
  return new AppError('PLAN_LIMIT_EXCEEDED', message, [
    { path, message: `Not available on the ${planName} plan` },
  ]);
}

/**
 * Gate for creating a booking. Throws `PLAN_LIMIT_EXCEEDED` (402) when the
 * plan has no room; returns silently otherwise.
 *
 * Both limits are checked in one pass so a tenant that is over on two counts
 * is told about the one it hits first, rather than fixing one and immediately
 * hitting the other.
 *
 * @param {object} args
 * @param {string} args.planId      the tenant's derived plan
 * @param {string} [args.resourceId] the resource the new booking would use
 */
export async function assertCanCreateBooking({ planId, resourceId }) {
  const plan = getPlan(planId) ?? getPlan('free');
  const { bookingsPerMonth, resources } = plan.limits;

  // Skip the queries entirely when nothing can fail — the Business plan pays
  // no price for a check that can only ever pass.
  if (isUnlimited(bookingsPerMonth) && isUnlimited(resources)) return;

  const { start, end } = currentUsagePeriod();

  if (!isUnlimited(bookingsPerMonth)) {
    const used = await Booking.countDocuments({ createdAt: { $gte: start, $lt: end } });
    if (used >= bookingsPerMonth) {
      throw limitError(plan.name, {
        path: 'body',
        message:
          `You have used all ${bookingsPerMonth} bookings included in the ` +
          `${plan.name} plan this month. Upgrade to keep booking, or wait for ` +
          `the limit to reset on ${end.toISOString().slice(0, 10)}.`,
      });
    }
  }

  if (!isUnlimited(resources) && resourceId) {
    const existing = await Booking.distinct('resourceId');
    // Only a NEW resource can push the count up. Booking a resource already in
    // use must keep working even for a tenant sitting at its limit.
    if (!existing.includes(resourceId) && existing.length >= resources) {
      throw limitError(plan.name, {
        path: 'body.resourceId',
        message:
          `The ${plan.name} plan covers ${resources} bookable ` +
          `${resources === 1 ? 'resource' : 'resources'}, and you are already ` +
          `using ${existing.length}. Upgrade to add "${resourceId}".`,
      });
    }
  }
}

/**
 * Gate for adding a user to a tenant.
 *
 * Returns a plain boolean + message rather than throwing an AppError, because
 * its one caller lives on a Week 1 route that speaks the flat
 * `{ error: "message" }` shape. Forcing the Week 2/3 envelope in there would
 * change a response contract the existing Register page already parses.
 *
 * @returns {Promise<{ allowed: boolean, message?: string }>}
 */
export async function checkCanAddUser(planId) {
  const plan = getPlan(planId) ?? getPlan('free');
  const { teamMembers } = plan.limits;

  if (isUnlimited(teamMembers)) return { allowed: true };

  const used = await User.countDocuments({});
  if (used < teamMembers) return { allowed: true };

  return {
    allowed: false,
    message:
      `The ${plan.name} plan includes ${teamMembers} team ` +
      `${teamMembers === 1 ? 'member' : 'members'}. Ask an owner to upgrade ` +
      'the workspace before adding another.',
  };
}
