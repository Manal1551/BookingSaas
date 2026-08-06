import { Link } from 'react-router-dom';
import DashboardLayout from '../components/DashboardLayout.jsx';
import { useAuth } from '../components/TenantContext.jsx';
import { rootUrl } from '../lib/useTenant.js';

/**
 * Dashboard overview. Chrome (sidebar + topbar + mobile drawer) lives in the
 * shared DashboardLayout, which the Bookings page reuses too.
 */
export default function Dashboard() {
  const { user, tenant } = useAuth();

  return (
    <DashboardLayout>
      <h1 className="text-2xl font-bold text-slate-900">
        Welcome back, {user?.name?.split(' ')[0]} 👋
      </h1>
      <p className="mt-1 text-slate-500">
        This is the <strong>{tenant?.name}</strong> workspace. Everything you see
        here is scoped to this tenant only.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Your role" value={user?.role} />
        <StatCard label="Workspace slug" value={tenant?.slug} />
        <StatCard label="Plan" value={tenant?.plan} />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="font-semibold text-slate-800">Bookings</h2>
          <p className="mt-2 text-sm text-slate-500">
            Manage appointments on the calendar — create, edit, and cancel
            bookings, all scoped to this tenant.
          </p>
          <Link to="/dashboard/bookings" className="btn-primary mt-4 inline-flex">
            Open bookings
          </Link>
        </div>

        <div className="card">
          <h2 className="font-semibold text-slate-800">Subscription</h2>
          <p className="mt-2 text-sm text-slate-500">
            You are on the <strong className="capitalize">{tenant?.plan}</strong>{' '}
            plan. Compare plans, or review invoices and payment details.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to="/dashboard/plans" className="btn-primary inline-flex">
              {tenant?.plan === 'free' ? 'Upgrade' : 'Change plan'}
            </Link>
            <Link to="/dashboard/billing" className="btn-ghost inline-flex">
              Billing history
            </Link>
          </div>
        </div>
      </div>

      <p className="mt-8 text-center text-xs text-slate-400">
        Not your workspace?{' '}
        <a href={rootUrl('/')} className="underline">
          Go to the main site
        </a>
      </p>
    </DashboardLayout>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold capitalize text-slate-900">
        {value || '—'}
      </div>
    </div>
  );
}
