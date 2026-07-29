import Modal from './Modal.jsx';
import { BOOKING_STATUSES } from '@shared/booking.schemas.js';
import { toDatetimeLocal, fromDatetimeLocal } from '../lib/datetime.js';

/**
 * Filter controls for the bookings views.
 *
 * On desktop these render inline above the table; on mobile the same controls
 * are presented in a bottom sheet (Modal is already an `items-end` sheet under
 * `sm`), keeping the list itself full-width on small screens.
 */

const SORT_OPTIONS = [
  { value: 'startAt', label: 'Soonest first' },
  { value: '-startAt', label: 'Latest first' },
  { value: '-createdAt', label: 'Recently created' },
  { value: 'createdAt', label: 'Oldest created' },
];

export function FilterControls({ value, onChange, showRange = true, showSort = true }) {
  const set = (key) => (e) => onChange({ ...value, [key]: e.target.value });

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <label className="label" htmlFor="filter-status">
          Status
        </label>
        <select
          id="filter-status"
          className="input capitalize"
          value={value.status}
          onChange={set('status')}
        >
          <option value="">All statuses</option>
          {BOOKING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="label" htmlFor="filter-resource">
          Resource
        </label>
        <input
          id="filter-resource"
          className="input"
          placeholder="Any resource"
          value={value.resourceId}
          onChange={set('resourceId')}
        />
      </div>

      {showRange && (
        <>
          <div>
            <label className="label" htmlFor="filter-from">
              From
            </label>
            <input
              id="filter-from"
              type="datetime-local"
              className="input"
              value={toDatetimeLocal(value.from)}
              onChange={(e) =>
                onChange({ ...value, from: fromDatetimeLocal(e.target.value) })
              }
            />
          </div>
          <div>
            <label className="label" htmlFor="filter-to">
              To
            </label>
            <input
              id="filter-to"
              type="datetime-local"
              className="input"
              value={toDatetimeLocal(value.to)}
              onChange={(e) =>
                onChange({ ...value, to: fromDatetimeLocal(e.target.value) })
              }
            />
          </div>
        </>
      )}

      {showSort && (
        <div>
          <label className="label" htmlFor="filter-sort">
            Sort
          </label>
          <select
            id="filter-sort"
            className="input"
            value={value.sort}
            onChange={set('sort')}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/** Mobile presentation: the same controls inside a bottom sheet. */
export function FilterSheet({ open, value, onChange, onClose, onReset }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Filters"
      footer={
        <>
          <button type="button" className="btn-ghost" onClick={onReset}>
            Reset
          </button>
          <button type="button" className="btn-primary" onClick={onClose}>
            Show results
          </button>
        </>
      }
    >
      <FilterControls value={value} onChange={onChange} />
    </Modal>
  );
}

export const EMPTY_FILTERS = {
  status: '',
  resourceId: '',
  from: '',
  to: '',
  sort: 'startAt',
};

/** Count of filters the user has actually set (for the mobile button badge). */
export function activeFilterCount(value) {
  let n = 0;
  if (value.status) n += 1;
  if (value.resourceId) n += 1;
  if (value.from) n += 1;
  if (value.to) n += 1;
  return n;
}
