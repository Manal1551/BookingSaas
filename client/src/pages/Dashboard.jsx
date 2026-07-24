import { useState } from 'react';
import Sidebar from '../components/Sidebar.jsx';
import { useAuth } from '../components/TenantContext.jsx';
import { rootUrl } from '../lib/useTenant.js';

/**
 * Dashboard shell: persistent sidebar on desktop, hamburger drawer on mobile,
 * a top bar with tenant name + user, logout, and a placeholder content area.
 */
export default function Dashboard() {
  const { user, tenant, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function onLogout() {
    await logout();
    window.location.href = '/login';
  }

  const initials = (user?.name || '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-full">
      <Sidebar
        tenantName={tenant?.name}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <button
              className="btn-ghost -ml-2 p-2 lg:hidden"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open menu"
            >
              ☰
            </button>
            <div>
              <div className="text-sm font-semibold text-slate-800">
                {tenant?.name}
              </div>
              <div className="text-xs text-slate-400">
                {tenant?.slug} · {tenant?.plan} plan
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium text-slate-700">
                {user?.name}
              </div>
              <div className="text-xs text-slate-400">{user?.role}</div>
            </div>
            <div className="grid h-9 w-9 place-items-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
              {initials}
            </div>
            <button className="btn-ghost" onClick={onLogout}>
              Logout
            </button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <h1 className="text-2xl font-bold text-slate-900">
            Welcome back, {user?.name?.split(' ')[0]} 👋
          </h1>
          <p className="mt-1 text-slate-500">
            This is the <strong>{tenant?.name}</strong> workspace. Everything you
            see here is scoped to this tenant only.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard label="Your role" value={user?.role} />
            <StatCard label="Workspace slug" value={tenant?.slug} />
            <StatCard label="Plan" value={tenant?.plan} />
          </div>

          <div className="mt-8 card">
            <h2 className="font-semibold text-slate-800">Placeholder content</h2>
            <p className="mt-2 text-sm text-slate-500">
              Business data (bookings, customers, etc.) will render here in later
              weeks. Any collection added will be tenant-scoped automatically via
              the Mongoose plugin.
            </p>
          </div>

          <p className="mt-8 text-center text-xs text-slate-400">
            Not your workspace?{' '}
            <a href={rootUrl('/')} className="underline">
              Go to the main site
            </a>
          </p>
        </main>
      </div>
    </div>
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
