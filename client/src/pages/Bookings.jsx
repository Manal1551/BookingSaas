import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';

import DashboardLayout from '../components/DashboardLayout.jsx';
import BookingForm from '../components/BookingForm.jsx';
import BookingDetail from '../components/BookingDetail.jsx';
import StatusBadge, { STATUS_COLORS } from '../components/StatusBadge.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  FilterControls,
  FilterSheet,
  EMPTY_FILTERS,
  activeFilterCount,
} from '../components/BookingFilters.jsx';
import { useBookingList, bookingKeys } from '../hooks/useBookings.js';
import { useIsMobile } from '../hooks/useMediaQuery.js';
import { bookingApi, describeError } from '../lib/bookingApi.js';
import { formatRange } from '../lib/datetime.js';
import { SLOT_MINUTES } from '@shared/booking.schemas.js';

const LIST_PAGE_SIZE = 20;

/**
 * Calendar + list over the same data.
 *
 * FullCalendar is used rather than a hand-rolled CSS grid because it already
 * solves the parts that are genuinely fiddly — overlapping event layout,
 * week/day time grids, DST-correct slot maths and keyboard navigation — and it
 * ships a `listWeek` agenda view, which is exactly what the mobile layout
 * needs. It was already a Week 1 dependency, so this costs nothing new.
 */
export default function Bookings() {
  const toast = useToast();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();

  const [view, setView] = useState('calendar');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [range, setRange] = useState(null); // visible calendar window
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null); // booking being viewed
  const [formState, setFormState] = useState(null); // { mode, booking }

  const isCalendar = view === 'calendar';

  // Query params differ per view: the calendar fetches exactly its visible
  // window, the list paginates over the user's chosen range.
  const params = useMemo(() => {
    const common = {
      status: filters.status || undefined,
      resourceId: filters.resourceId || undefined,
    };
    return isCalendar
      ? { ...common, from: range?.from, to: range?.to, limit: 200, sort: 'startAt' }
      : {
          ...common,
          from: filters.from || undefined,
          to: filters.to || undefined,
          page,
          limit: LIST_PAGE_SIZE,
          sort: filters.sort,
        };
  }, [isCalendar, filters, range, page]);

  const query = useBookingList(params, {
    // The calendar cannot fetch until FullCalendar reports its window.
    enabled: !isCalendar || Boolean(range),
  });

  const bookings = query.data?.bookings ?? [];

  const changeFilters = useCallback((next) => {
    setFilters(next);
    setPage(1);
  }, []);

  const onDatesSet = useCallback((arg) => {
    const from = arg.start.toISOString();
    const to = arg.end.toISOString();
    // Guard against re-setting an identical window (FullCalendar fires this on
    // every render, which would otherwise loop).
    setRange((prev) => (prev && prev.from === from && prev.to === to ? prev : { from, to }));
  }, []);

  function openCreate(start, end) {
    const prefill = start
      ? {
          startAt: snapToGrid(start).toISOString(),
          endAt: snapToGrid(end || new Date(start.getTime() + 3_600_000)).toISOString(),
        }
      : null;
    setFormState({ mode: 'create', booking: prefill });
  }

  function onSaved(saved) {
    const wasEdit = formState?.mode === 'edit';
    setFormState(null);
    toast.success(wasEdit ? 'Booking updated' : 'Booking created');
    if (wasEdit && detail) setDetail(saved);
  }

  /** The edited booking moved under us — offer a reload rather than clobbering. */
  function onStale() {
    const staleId = formState?.booking?.id ?? detail?.id;
    setFormState(null);
    toast.error('This booking changed while you were editing it.', {
      action: {
        label: 'Reload and edit again',
        onClick: async () => {
          await queryClient.invalidateQueries({ queryKey: bookingKeys.all });
          try {
            const fresh = await bookingApi.get(staleId);
            if (fresh?.booking) setFormState({ mode: 'edit', booking: fresh.booking });
          } catch (err) {
            toast.error(describeError(err).message);
          }
        },
      },
    });
  }

  const events = bookings.map((b) => ({
    id: b.id,
    title: `${b.serviceName} — ${b.customerName}`,
    start: b.startAt,
    end: b.endAt,
    backgroundColor: STATUS_COLORS[b.status],
    borderColor: STATUS_COLORS[b.status],
    extendedProps: { booking: b },
  }));

  const filterCount = activeFilterCount(filters);

  return (
    <DashboardLayout>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Bookings</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage appointments for this workspace.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          {isMobile && (
            <button
              className="btn-ghost min-h-[44px]"
              onClick={() => setSheetOpen(true)}
              aria-label={`Filters${filterCount ? `, ${filterCount} active` : ''}`}
            >
              Filters{filterCount ? ` (${filterCount})` : ''}
            </button>
          )}
          <button className="btn-primary min-h-[44px]" onClick={() => openCreate()}>
            + New booking
          </button>
        </div>
      </div>

      {/* Desktop filters inline; mobile filters live in the bottom sheet. */}
      {!isMobile && (
        <div className="mt-5 card p-4">
          <FilterControls
            value={filters}
            onChange={changeFilters}
            showRange={!isCalendar}
            showSort={!isCalendar}
          />
          {filterCount > 0 && (
            <button
              className="mt-3 text-sm font-medium text-brand-600 hover:underline"
              onClick={() => changeFilters(EMPTY_FILTERS)}
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      <div className="mt-5 card p-3 sm:p-5">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : isCalendar ? (
          <CalendarView
            events={events}
            isMobile={isMobile}
            loading={query.isPending || query.isFetching}
            onDatesSet={onDatesSet}
            onEventClick={(arg) => setDetail(arg.event.extendedProps.booking)}
            onSelect={(arg) => openCreate(arg.start, arg.end)}
            onDateClick={(arg) => {
              const start = new Date(arg.date);
              if (arg.allDay) start.setHours(9, 0, 0, 0);
              openCreate(start);
            }}
          />
        ) : (
          <ListView
            bookings={bookings}
            meta={query.data}
            loading={query.isPending}
            fetching={query.isFetching}
            page={page}
            onPage={setPage}
            sort={filters.sort}
            onSort={(sort) => changeFilters({ ...filters, sort })}
            onOpen={setDetail}
            onCreate={() => openCreate()}
          />
        )}
      </div>

      <FilterSheet
        open={sheetOpen}
        value={filters}
        onChange={changeFilters}
        onClose={() => setSheetOpen(false)}
        onReset={() => changeFilters(EMPTY_FILTERS)}
      />

      {detail && (
        <BookingDetail
          bookingId={detail.id}
          initial={detail}
          onClose={() => setDetail(null)}
          onEdit={(b) => {
            setDetail(null);
            setFormState({ mode: 'edit', booking: b });
          }}
          onDeleted={() => setDetail(null)}
        />
      )}

      {formState && (
        <BookingForm
          mode={formState.mode}
          booking={formState.booking}
          onClose={() => setFormState(null)}
          onSaved={onSaved}
          onStale={onStale}
        />
      )}
    </DashboardLayout>
  );
}

/** Round a clicked time onto the API's 5-minute grid. */
function snapToGrid(date) {
  const d = new Date(date);
  d.setSeconds(0, 0);
  d.setMinutes(Math.round(d.getMinutes() / SLOT_MINUTES) * SLOT_MINUTES);
  return d;
}

function ViewToggle({ view, onChange }) {
  const opts = [
    { key: 'calendar', label: 'Calendar' },
    { key: 'list', label: 'List' },
  ];
  return (
    <div className="inline-flex rounded-lg border border-slate-300 p-0.5" role="tablist">
      {opts.map((o) => (
        <button
          key={o.key}
          role="tab"
          aria-selected={view === o.key}
          onClick={() => onChange(o.key)}
          className={[
            'min-h-[40px] rounded-md px-3 py-1.5 text-sm font-medium transition',
            view === o.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function CalendarView({ events, isMobile, loading, onDatesSet, onEventClick, onSelect, onDateClick }) {
  return (
    <div className="fc-wrap relative">
      {loading && (
        <div className="absolute right-2 top-2 z-10 rounded-full bg-white/90 px-3 py-1 text-xs text-slate-500 shadow">
          Loading…
        </div>
      )}
      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
        // On mobile a month grid is unreadable — collapse to a day agenda.
        initialView={isMobile ? 'listDay' : 'dayGridMonth'}
        key={isMobile ? 'mobile' : 'desktop'}
        headerToolbar={
          isMobile
            ? { left: 'prev,next', center: 'title', right: 'listDay,timeGridDay' }
            : {
                left: 'prev,next today',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay,listWeek',
              }
        }
        height="auto"
        selectable
        selectMirror
        dayMaxEvents={3}
        nowIndicator
        slotDuration={`00:${String(SLOT_MINUTES * 3).padStart(2, '0')}:00`}
        snapDuration={`00:${String(SLOT_MINUTES).padStart(2, '0')}:00`}
        events={events}
        datesSet={onDatesSet}
        eventClick={onEventClick}
        select={onSelect}
        dateClick={onDateClick}
        noEventsContent="No bookings in this range"
        // Screen readers otherwise announce day cells as bare numbers.
        dayCellDidMount={(arg) => {
          arg.el.setAttribute('role', 'gridcell');
          arg.el.setAttribute('aria-label', arg.date.toDateString());
        }}
        eventDidMount={(arg) => {
          const b = arg.event.extendedProps.booking;
          if (b) {
            arg.el.setAttribute(
              'aria-label',
              `${b.serviceName} for ${b.customerName}, ${b.status}, ${formatRange(b.startAt, b.endAt)}`
            );
          }
        }}
      />
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  const { message, requestId } = describeError(error);
  return (
    <div role="alert" className="py-12 text-center">
      <p className="font-medium text-slate-900">Could not load bookings</p>
      <p className="mt-1 text-sm text-slate-500">{message}</p>
      {requestId && (
        <p className="mt-1 font-mono text-xs text-slate-400">Reference: {requestId}</p>
      )}
      <button className="btn-primary mt-4 min-h-[44px]" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2 py-2" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />
      ))}
    </div>
  );
}

function ListView({
  bookings,
  meta,
  loading,
  fetching,
  page,
  onPage,
  sort,
  onSort,
  onOpen,
  onCreate,
}) {
  if (loading) return <ListSkeleton />;

  if (!bookings.length) {
    return (
      <div className="py-16 text-center">
        <p className="font-medium text-slate-900">No bookings found</p>
        <p className="mt-1 text-sm text-slate-500">
          Nothing matches the current filters.
        </p>
        <button className="btn-primary mt-4 min-h-[44px]" onClick={onCreate}>
          Create a booking
        </button>
      </div>
    );
  }

  const totalPages = meta?.totalPages ?? 1;

  return (
    <div className={fetching ? 'opacity-60 transition-opacity' : undefined}>
      <div className="hidden items-center gap-4 border-b border-slate-200 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 sm:flex">
        <button
          className="hover:text-slate-700"
          onClick={() => onSort(sort === 'startAt' ? '-startAt' : 'startAt')}
        >
          When {sort === 'startAt' ? '↑' : sort === '-startAt' ? '↓' : ''}
        </button>
        <span className="flex-1">Booking</span>
        <button
          className="hover:text-slate-700"
          onClick={() => onSort(sort === '-createdAt' ? 'createdAt' : '-createdAt')}
        >
          Created {sort === '-createdAt' ? '↓' : sort === 'createdAt' ? '↑' : ''}
        </button>
      </div>

      <ul className="divide-y divide-slate-100">
        {bookings.map((b) => (
          <li key={b.id}>
            <button
              onClick={() => onOpen(b)}
              className="flex min-h-[44px] w-full flex-col gap-1 px-1 py-3 text-left transition hover:bg-slate-50 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-slate-900">
                    {b.serviceName}
                  </span>
                  <StatusBadge status={b.status} />
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                    {b.resourceId}
                  </span>
                </div>
                <div className="truncate text-sm text-slate-500">
                  {b.customerName} · {b.customerEmail}
                </div>
              </div>
              <div className="flex-shrink-0 text-sm text-slate-600 sm:text-right">
                {formatRange(b.startAt, b.endAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <button
            className="btn-ghost min-h-[44px]"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            ← Previous
          </button>
          <span className="text-sm text-slate-500">
            Page {page} of {totalPages} · {meta?.total ?? 0} total
          </span>
          <button
            className="btn-ghost min-h-[44px]"
            disabled={!meta?.hasMore}
            onClick={() => onPage(page + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
