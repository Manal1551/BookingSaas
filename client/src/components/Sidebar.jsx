import { NavLink } from 'react-router-dom';

const NAV = [
  { to: '/dashboard', label: 'Overview', icon: '▦' },
  { to: '/dashboard/bookings', label: 'Bookings', icon: '▤' },
  { to: '/dashboard/team', label: 'Team', icon: '▣' },
  { to: '/dashboard/settings', label: 'Settings', icon: '▧' },
];

/**
 * Collapsible sidebar. On desktop it is a persistent column; on mobile it is a
 * slide-over drawer controlled by `open` / `onClose` from the dashboard shell.
 */
export default function Sidebar({ tenantName, open, onClose }) {
  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={[
          'fixed inset-y-0 left-0 z-40 w-64 transform border-r border-slate-200 bg-white transition-transform duration-200 ease-in-out',
          'lg:static lg:z-auto lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        ].join(' ')}
      >
        <div className="flex h-16 items-center gap-2 border-b border-slate-200 px-5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            {(tenantName || 'S').charAt(0).toUpperCase()}
          </div>
          <span className="truncate font-semibold text-slate-800">
            {tenantName || 'SaaS'}
          </span>
        </div>

        <nav className="space-y-1 p-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/dashboard'}
              onClick={onClose}
              className={({ isActive }) =>
                [
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition',
                  isActive
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                ].join(' ')
              }
            >
              <span className="text-base leading-none">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
    </>
  );
}
