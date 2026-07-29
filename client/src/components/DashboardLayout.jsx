import { useState } from 'react';
import Sidebar from './Sidebar.jsx';
import { useAuth } from './TenantContext.jsx';

/**
 * Shared dashboard chrome: persistent sidebar on desktop, hamburger drawer on
 * mobile, and a top bar with tenant name + user + logout. Pages render their
 * own content as `children`; an optional `title`/`actions` slot sits in the
 * page header row.
 */
export default function DashboardLayout({ children }) {
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

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
