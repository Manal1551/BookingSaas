import { formatMoney, formatDate } from '../lib/billingApi.js';

/**
 * Billing history.
 *
 * Responsive by switching layout rather than by scrolling a wide table
 * sideways: a real table on desktop, stacked cards on mobile. A horizontally
 * scrolling table of money is easy to misread, and misreading an invoice is
 * worse than a slightly taller page.
 *
 * The PDF and receipt links point straight at Stripe. They are not proxied —
 * Stripe hosts them, expires them on its own schedule, and serving them
 * ourselves would mean holding invoice documents we have no reason to hold.
 */

const STATUS_STYLES = {
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  open: 'bg-amber-50 text-amber-700 ring-amber-200',
  draft: 'bg-slate-100 text-slate-600 ring-slate-200',
  void: 'bg-slate-100 text-slate-500 ring-slate-200',
  uncollectible: 'bg-red-50 text-red-700 ring-red-200',
};

const STATUS_LABEL = {
  paid: 'Paid',
  open: 'Due',
  draft: 'Draft',
  void: 'Voided',
  uncollectible: 'Unpaid',
};

function InvoiceStatus({ status }) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        STATUS_STYLES[status] || STATUS_STYLES.draft,
      ].join(' ')}
    >
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function InvoiceLinks({ invoice }) {
  if (!invoice.hostedInvoiceUrl && !invoice.invoicePdfUrl) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  return (
    <div className="flex items-center gap-3 text-sm">
      {invoice.hostedInvoiceUrl && (
        <a
          href={invoice.hostedInvoiceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand-600 hover:underline"
        >
          View
        </a>
      )}
      {invoice.invoicePdfUrl && (
        <a
          href={invoice.invoicePdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-slate-500 hover:text-slate-800 hover:underline"
        >
          PDF
        </a>
      )}
    </div>
  );
}

export default function InvoiceTable({ invoices = [], loading, emptyHint }) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    );
  }

  if (!invoices.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center">
        <p className="text-sm font-medium text-slate-600">No invoices yet</p>
        <p className="mt-1 text-sm text-slate-400">
          {emptyHint ?? 'Invoices appear here as soon as your first payment is processed.'}
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Desktop */}
      <div className="hidden overflow-hidden rounded-xl border border-slate-200 sm:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Invoice</th>
              <th scope="col" className="px-4 py-3 font-medium">Date</th>
              <th scope="col" className="px-4 py-3 font-medium">Period</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                <span className="sr-only">Links</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {invoice.number || '—'}
                  {invoice.planId && (
                    <span className="ml-2 text-xs capitalize text-slate-400">
                      {invoice.planId}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">
                  {formatDate(invoice.paidAt || invoice.issuedAt)}
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {invoice.periodStart
                    ? `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`
                    : '—'}
                </td>
                <td className="px-4 py-3">
                  <InvoiceStatus status={invoice.status} />
                </td>
                <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">
                  {formatMoney(
                    invoice.status === 'paid' ? invoice.amountPaid : invoice.amountDue,
                    invoice.currency
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <InvoiceLinks invoice={invoice} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile */}
      <ul className="space-y-3 sm:hidden">
        {invoices.map((invoice) => (
          <li
            key={invoice.id}
            className="rounded-xl border border-slate-200 bg-white p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">
                  {invoice.number || 'Invoice'}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {formatDate(invoice.paidAt || invoice.issuedAt)}
                </p>
              </div>
              <span className="flex-shrink-0 font-semibold tabular-nums text-slate-900">
                {formatMoney(
                  invoice.status === 'paid' ? invoice.amountPaid : invoice.amountDue,
                  invoice.currency
                )}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <InvoiceStatus status={invoice.status} />
              <InvoiceLinks invoice={invoice} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
