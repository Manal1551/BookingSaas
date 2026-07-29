import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBookingInputSchema,
  updateBookingInputSchema,
  listBookingsQuerySchema,
  bookingIdParamsSchema,
  isAlignedToSlotGrid,
  SLOT_MINUTES,
  MAX_DURATION_MINUTES,
} from '../src/validation/booking.schemas.js';

/**
 * Fast, DB-free unit tests for the shared schemas. These are the same rules
 * the browser enforces (the client imports this module through the
 * `@shared` Vite alias), so a failure here means client and server would
 * disagree.
 */

/** A grid-aligned window in the future. */
function futureWindow({ offsetMinutes = 120, durationMinutes = 60 } = {}) {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 5) * 5);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

const validCreate = (overrides = {}) => ({
  customerName: 'Ada Lovelace',
  customerEmail: 'ada@example.com',
  serviceName: 'Design call',
  resourceId: 'room-1',
  ...futureWindow(),
  ...overrides,
});

const firstIssuePath = (result) => result.error.issues[0].path.join('.');

// --- create -----------------------------------------------------------------

test('create schema accepts a well-formed booking', () => {
  const result = createBookingInputSchema.parse(validCreate());
  assert.equal(result.customerEmail, 'ada@example.com');
  assert.equal(result.notes, '', 'notes defaults to an empty string');
});

test('create schema requires a resourceId', () => {
  const { resourceId, ...withoutResource } = validCreate();
  const result = createBookingInputSchema.safeParse(withoutResource);
  assert.equal(result.success, false);
  assert.equal(firstIssuePath(result), 'resourceId');
});

test('create schema rejects a resourceId with unsafe characters', () => {
  const result = createBookingInputSchema.safeParse(
    validCreate({ resourceId: 'room 1/../etc' })
  );
  assert.equal(result.success, false);
});

test('create schema rejects an end time before the start time', () => {
  const w = futureWindow();
  const result = createBookingInputSchema.safeParse({
    ...validCreate(),
    startAt: w.endAt,
    endAt: w.startAt,
  });
  assert.equal(result.success, false);
  assert.equal(firstIssuePath(result), 'endAt');
});

test('create schema rejects a booking in the past', () => {
  const result = createBookingInputSchema.safeParse({
    ...validCreate(),
    startAt: '2020-01-01T10:00:00.000Z',
    endAt: '2020-01-01T11:00:00.000Z',
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path[0] === 'startAt'));
});

test(`create schema rejects a duration over ${MAX_DURATION_MINUTES / 60}h`, () => {
  const result = createBookingInputSchema.safeParse({
    ...validCreate(),
    ...futureWindow({ durationMinutes: MAX_DURATION_MINUTES + SLOT_MINUTES }),
  });
  assert.equal(result.success, false);
  assert.equal(firstIssuePath(result), 'endAt');
});

test(`create schema rejects times off the ${SLOT_MINUTES}-minute grid`, () => {
  const w = futureWindow();
  const offGrid = new Date(w.startAt);
  offGrid.setUTCMinutes(offGrid.getUTCMinutes() + 2);
  const result = createBookingInputSchema.safeParse({
    ...validCreate(),
    startAt: offGrid.toISOString(),
  });
  assert.equal(result.success, false);
  assert.equal(firstIssuePath(result), 'startAt');
});

test('create schema rejects an invalid email', () => {
  const result = createBookingInputSchema.safeParse(
    validCreate({ customerEmail: 'nope' })
  );
  assert.equal(result.success, false);
});

test('create schema is strict — unknown keys are rejected', () => {
  const result = createBookingInputSchema.safeParse({ ...validCreate(), bogus: 'nope' });
  assert.equal(result.success, false);
});

// --- update -----------------------------------------------------------------

test('update schema allows partial edits without requiring every field', () => {
  const result = updateBookingInputSchema.parse({
    status: 'confirmed',
    notes: 'Updated note',
    version: 3,
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.version, 3);
});

test('update schema does NOT forbid past times (the controller decides)', () => {
  const result = updateBookingInputSchema.safeParse({
    startAt: '2020-01-01T10:00:00.000Z',
    endAt: '2020-01-01T11:00:00.000Z',
  });
  assert.equal(result.success, true);
});

test('update schema still enforces date order when both dates are present', () => {
  const w = futureWindow();
  const result = updateBookingInputSchema.safeParse({
    startAt: w.endAt,
    endAt: w.startAt,
  });
  assert.equal(result.success, false);
});

test('update schema rejects an empty patch', () => {
  const result = updateBookingInputSchema.safeParse({ version: 1 });
  assert.equal(result.success, false);
});

test('update schema is strict — unknown keys are rejected', () => {
  assert.equal(updateBookingInputSchema.safeParse({ bogus: true }).success, false);
});

// --- list query -------------------------------------------------------------

test('list query schema coerces and defaults page/limit/sort', () => {
  const result = listBookingsQuerySchema.parse({});
  assert.equal(result.page, 1);
  assert.equal(result.limit, 100);
  assert.equal(result.sort, 'startAt');
});

test('list query schema coerces numeric strings', () => {
  const result = listBookingsQuerySchema.parse({ page: '2', limit: '50' });
  assert.equal(result.page, 2);
  assert.equal(result.limit, 50);
});

test('list query schema caps limit at 200', () => {
  assert.equal(listBookingsQuerySchema.safeParse({ limit: '500' }).success, false);
});

test('list query schema rejects an invalid status', () => {
  assert.equal(listBookingsQuerySchema.safeParse({ status: 'archived' }).success, false);
});

test('list query schema rejects a reversed range', () => {
  const w = futureWindow();
  const result = listBookingsQuerySchema.safeParse({ from: w.endAt, to: w.startAt });
  assert.equal(result.success, false);
});

test('list query schema accepts every documented sort', () => {
  for (const sort of ['startAt', '-startAt', 'createdAt', '-createdAt']) {
    assert.equal(listBookingsQuerySchema.parse({ sort }).sort, sort);
  }
});

// --- params + helpers -------------------------------------------------------

test('id params schema accepts an ObjectId and rejects anything else', () => {
  assert.equal(
    bookingIdParamsSchema.parse({ id: '507f1f77bcf86cd799439011' }).id,
    '507f1f77bcf86cd799439011'
  );
  assert.equal(bookingIdParamsSchema.safeParse({ id: 'nope' }).success, false);
});

test('isAlignedToSlotGrid recognises grid boundaries', () => {
  assert.equal(isAlignedToSlotGrid('2027-01-01T10:00:00.000Z'), true);
  assert.equal(isAlignedToSlotGrid('2027-01-01T10:05:00.000Z'), true);
  assert.equal(isAlignedToSlotGrid('2027-01-01T10:02:00.000Z'), false);
  assert.equal(isAlignedToSlotGrid('2027-01-01T10:00:30.000Z'), false);
});
