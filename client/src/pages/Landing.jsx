import { useState } from 'react';
import { tenantApi, ApiError } from '../lib/api.js';
import { tenantUrl, ROOT_DOMAIN } from '../lib/useTenant.js';

/**
 * Marketing + tenant sign-up, served on the ROOT domain (app.local).
 * A new company picks a subdomain, we check availability, create the tenant,
 * then send them to their own subdomain's /register page.
 *
 * Layout: a persistent branded sidebar (desktop) + a hero with the signup card,
 * a code showcase, a feature grid, and a CTA band. The sidebar collapses to a
 * top bar on mobile.
 */
export default function Landing() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [status, setStatus] = useState(null); // {available, reason} | null
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const normalizedSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');

  async function checkAvailability(value) {
    if (!value) {
      setStatus(null);
      return;
    }
    setChecking(true);
    try {
      const res = await tenantApi.checkSlug(value);
      setStatus(res);
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }

  function onSlugChange(e) {
    const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    setSlug(v);
    setStatus(null);
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim() || !normalizedSlug) {
      setError('Please enter a company name and subdomain.');
      return;
    }
    setSubmitting(true);
    try {
      await tenantApi.create({ name: name.trim(), slug: normalizedSlug });
      // Off to the new tenant's registration page.
      window.location.href = tenantUrl(normalizedSlug, '/register');
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not create workspace.'
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full bg-white">
      <LandingSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar (sidebar is hidden below lg) */}
        <header className="flex items-center justify-between px-6 py-5 lg:hidden">
          <Brand />
          <a href="#signup" className="btn-primary">
            Get started
          </a>
        </header>

        <main className="flex-1">
          {/* ================= HERO ================= */}
          <section id="top" className="relative overflow-hidden">
            {/* layered background: grid + gradient orbs */}
            <div
              aria-hidden="true"
              className="mask-fade-b pointer-events-none absolute inset-0 bg-grid"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-32 -top-40 h-[30rem] w-[30rem] rounded-full bg-gradient-to-br from-brand-200 to-violet-200 opacity-50 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -bottom-40 left-10 h-96 w-96 rounded-full bg-indigo-100 opacity-60 blur-3xl"
            />

            <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-24">
              {/* Left: copy */}
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-brand-100 bg-white/80 px-3 py-1 text-xs font-semibold text-brand-700 shadow-sm backdrop-blur">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-600" />
                  </span>
                  Multi-tenant SaaS · Week 1 starter
                </span>

                <h1 className="mt-6 text-5xl font-extrabold leading-[1.02] tracking-tight text-slate-900 sm:text-6xl">
                  Launch a SaaS where{' '}
                  <span className="text-gradient">every tenant is isolated.</span>
                </h1>

                <p className="mt-6 max-w-lg text-lg leading-relaxed text-slate-600">
                  Give every customer their own subdomain and a workspace sealed
                  off at the database level. No tenant can ever read — or even
                  see — another&apos;s data. Enforced in code, proven by tests.
                </p>

                <div className="mt-8 flex flex-wrap items-center gap-4">
                  <a
                    href="#signup"
                    className="btn-primary px-6 py-3 text-base shadow-lg shadow-brand-600/25 transition hover:-translate-y-0.5"
                  >
                    Create your workspace →
                  </a>
                  <a
                    href="#features"
                    className="text-sm font-semibold text-slate-600 transition hover:text-slate-900"
                  >
                    See how it works
                  </a>
                </div>

                <div className="mt-6 flex items-center gap-2 text-sm text-slate-500">
                  <span className="text-emerald-500">✓</span> Free to start
                  <span className="mx-1 text-slate-300">·</span>
                  <span className="text-emerald-500">✓</span> No credit card
                  <span className="mx-1 text-slate-300">·</span>
                  <span className="text-emerald-500">✓</span> Deploy locally
                </div>

                <dl className="mt-12 grid max-w-lg grid-cols-3 divide-x divide-slate-200 rounded-2xl border border-slate-200 bg-white/60 py-5 backdrop-blur">
                  <Stat value="100%" label="Tenant isolation" />
                  <Stat value="< 1s" label="To spin up" />
                  <Stat value="JWT" label="Per-tenant auth" />
                </dl>
              </div>

              {/* Right: signup card */}
              <div id="signup" className="lg:justify-self-end">
                <div className="relative w-full max-w-md">
                  {/* gradient ring behind the card */}
                  <div
                    aria-hidden="true"
                    className="absolute -inset-0.5 rounded-3xl bg-gradient-to-br from-brand-500 via-indigo-500 to-violet-500 opacity-20 blur"
                  />
                  <div className="relative rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-300/40 sm:p-8">
                    <h2 className="text-xl font-bold text-slate-900">
                      Create your workspace
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Pick a subdomain — it must be unique.
                    </p>

                    <form className="mt-6 space-y-4" onSubmit={onSubmit}>
                      <div>
                        <label className="label" htmlFor="company">
                          Company name
                        </label>
                        <input
                          id="company"
                          className="input"
                          placeholder="Acme Corporation"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </div>

                      <div>
                        <label className="label" htmlFor="slug">
                          Subdomain
                        </label>
                        <div className="flex items-stretch">
                          <input
                            id="slug"
                            className="input rounded-r-none"
                            placeholder="acme"
                            value={slug}
                            onChange={onSlugChange}
                            onBlur={() => checkAvailability(normalizedSlug)}
                            autoComplete="off"
                          />
                          <span className="inline-flex items-center rounded-r-lg border border-l-0 border-slate-300 bg-slate-50 px-3 text-sm text-slate-500">
                            .{ROOT_DOMAIN}
                          </span>
                        </div>
                        <div className="mt-1.5 h-5 text-xs">
                          {checking && (
                            <span className="text-slate-400">Checking…</span>
                          )}
                          {!checking && status && status.available && (
                            <span className="font-medium text-emerald-600">
                              ✓ {normalizedSlug}.{ROOT_DOMAIN} is available
                            </span>
                          )}
                          {!checking && status && !status.available && (
                            <span className="font-medium text-red-600">
                              ✕ Not available
                              {status.reason ? ` (${status.reason})` : ''}
                            </span>
                          )}
                        </div>
                      </div>

                      {error && (
                        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                          {error}
                        </div>
                      )}

                      <button
                        type="submit"
                        className="btn-primary w-full py-3 text-base shadow-lg shadow-brand-600/25"
                        disabled={submitting || (status && !status.available)}
                      >
                        {submitting ? 'Creating…' : 'Create workspace'}
                      </button>

                      <p className="text-center text-xs text-slate-400">
                        You&apos;ll be redirected to your subdomain to finish
                        signing up.
                      </p>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ================= CODE SHOWCASE ================= */}
          <section className="mx-auto max-w-6xl px-6 pb-8">
            <div className="grid items-center gap-8 rounded-3xl border border-slate-200 bg-slate-50/60 p-6 lg:grid-cols-2 lg:p-10">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-brand-600">
                  Isolation by default
                </span>
                <h2 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
                  Every query is scoped to the tenant — automatically.
                </h2>
                <p className="mt-3 text-slate-600">
                  A Mongoose plugin injects the current tenant into every read
                  and write. Forget to scope a query and it{' '}
                  <span className="font-semibold text-slate-900">
                    fails closed
                  </span>{' '}
                  — it never silently returns another tenant&apos;s data.
                </p>
                <ul className="mt-5 space-y-2.5 text-sm text-slate-600">
                  <Check>Request-scoped context via AsyncLocalStorage</Check>
                  <Check>Cross-tenant writes are rejected, not merged</Check>
                  <Check>Token replayed on another tenant → 403</Check>
                </ul>
              </div>

              <CodeCard />
            </div>
          </section>

          {/* ================= FEATURES ================= */}
          <section id="features" className="border-t border-slate-200 bg-white">
            <div className="mx-auto max-w-6xl px-6 py-20">
              <div className="mx-auto max-w-2xl text-center">
                <span className="text-xs font-bold uppercase tracking-wider text-brand-600">
                  Everything included
                </span>
                <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
                  The hard parts of multi-tenancy, already solved
                </h2>
                <p className="mt-3 text-slate-500">
                  Isolation, routing, and auth are wired up and proven — so you
                  can build features on day one.
                </p>
              </div>

              <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {FEATURES.map((f) => (
                  <div
                    key={f.title}
                    className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition duration-200 hover:-translate-y-1 hover:border-brand-200 hover:shadow-lg hover:shadow-brand-600/5"
                  >
                    <div className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-indigo-500 text-xl text-white shadow-lg shadow-brand-600/20">
                      {f.icon}
                    </div>
                    <h3 className="mt-5 font-semibold text-slate-900">
                      {f.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-500">
                      {f.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ================= CTA BAND ================= */}
          <section className="px-6 pb-20">
            <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 via-indigo-600 to-violet-600 px-8 py-14 text-center shadow-2xl shadow-brand-600/30">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_20%,white_1px,transparent_1px)] [background-size:24px_24px]"
              />
              <div className="relative">
                <h2 className="text-3xl font-extrabold tracking-tight text-white">
                  Ready to spin up your first workspace?
                </h2>
                <p className="mx-auto mt-3 max-w-xl text-brand-100">
                  Pick a subdomain and you&apos;ll be inside your own isolated
                  tenant in seconds.
                </p>
                <a
                  href="#signup"
                  className="mt-8 inline-flex items-center justify-center rounded-xl bg-white px-7 py-3 text-base font-semibold text-brand-700 shadow-lg transition hover:-translate-y-0.5 hover:bg-brand-50"
                >
                  Create your workspace →
                </a>
              </div>
            </div>
          </section>

          <footer className="border-t border-slate-200 py-8">
            <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 text-xs text-slate-400 sm:flex-row">
              <div className="flex items-center gap-2">
                <Brand />
              </div>
              <p>
                Multi-tenant starter · Isolated at the document level ·{' '}
                {new Date().getFullYear()}
              </p>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

/* ---------- Sidebar (desktop rail) ---------- */

const NAV = [
  { href: '#top', label: 'Overview', icon: '▦' },
  { href: '#features', label: 'Features', icon: '✦' },
  { href: '#signup', label: 'Create workspace', icon: '＋' },
];

function LandingSidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-800 bg-gradient-to-b from-slate-950 to-slate-900 px-5 py-6 text-slate-300 lg:flex">
      <Brand dark />

      <nav className="mt-8 space-y-1">
        {NAV.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 transition hover:bg-white/5 hover:text-white"
          >
            <span className="w-4 text-center text-slate-500 transition group-hover:text-brand-400">
              {item.icon}
            </span>
            {item.label}
          </a>
        ))}
      </nav>

      <div className="mt-8 rounded-xl border border-slate-800 bg-white/[0.03] p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Why isolated?
        </p>
        <ul className="mt-3 space-y-2.5 text-sm">
          <SidebarPoint>Document-level tenant isolation</SidebarPoint>
          <SidebarPoint>
            Subdomain routing (&lt;you&gt;.{ROOT_DOMAIN})
          </SidebarPoint>
          <SidebarPoint>JWT auth bound per tenant</SidebarPoint>
          <SidebarPoint>Same email, different tenants</SidebarPoint>
        </ul>
      </div>

      <div className="mt-auto pt-6">
        <a
          href="#signup"
          className="flex w-full items-center justify-center rounded-lg bg-gradient-to-r from-brand-600 to-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-600/30 transition hover:from-brand-500 hover:to-indigo-500"
        >
          Get started
        </a>
        <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-slate-500">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Week 1 · Multi-tenant architecture
        </div>
      </div>
    </aside>
  );
}

function SidebarPoint({ children }) {
  return (
    <li className="flex items-start gap-2 text-slate-300">
      <span className="mt-0.5 text-emerald-400">✓</span>
      <span className="leading-snug">{children}</span>
    </li>
  );
}

/* ---------- Code showcase card ---------- */

function CodeCard() {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-slate-900/30">
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red-400/80" />
        <span className="h-3 w-3 rounded-full bg-amber-400/80" />
        <span className="h-3 w-3 rounded-full bg-emerald-400/80" />
        <span className="ml-3 text-xs font-medium text-slate-500">
          tenantScopePlugin.js
        </span>
      </div>
      <pre className="overflow-x-auto p-5 text-[13px] leading-relaxed">
        <code className="font-mono">
          <span className="text-slate-500">
            {'// runs inside the request’s tenant context'}
          </span>
          {'\n'}
          <span className="text-violet-400">schema</span>
          <span className="text-slate-300">.</span>
          <span className="text-sky-300">pre</span>
          <span className="text-slate-300">(</span>
          <span className="text-emerald-300">'find'</span>
          <span className="text-slate-300">, </span>
          <span className="text-sky-300">function</span>
          <span className="text-slate-300"> {'() {'}</span>
          {'\n  '}
          <span className="text-sky-300">const</span>
          <span className="text-slate-300"> tenantId = </span>
          <span className="text-sky-300">getTenantId</span>
          <span className="text-slate-300">();</span>
          {'\n  '}
          <span className="text-fuchsia-400">if</span>
          <span className="text-slate-300"> (!tenantId) </span>
          <span className="text-fuchsia-400">throw</span>
          <span className="text-slate-300"> </span>
          <span className="text-sky-300">Error</span>
          <span className="text-slate-300">(</span>
          <span className="text-emerald-300">'no tenant → refuse'</span>
          <span className="text-slate-300">);</span>
          {'\n\n  '}
          <span className="text-slate-500">{'// scope every query, always'}</span>
          {'\n  '}
          <span className="text-sky-300">this</span>
          <span className="text-slate-300">.</span>
          <span className="text-sky-300">setQuery</span>
          <span className="text-slate-300">({'{ ...'}</span>
          <span className="text-sky-300">this</span>
          <span className="text-slate-300">.</span>
          <span className="text-sky-300">getQuery</span>
          <span className="text-slate-300">(), tenantId {'}'});</span>
          {'\n'}
          <span className="text-slate-300">{'});'}</span>
        </code>
      </pre>
    </div>
  );
}

/* ---------- Small building blocks ---------- */

function Brand({ dark = false }) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600 font-bold text-white shadow-lg shadow-brand-600/30">
        S
      </div>
      <span
        className={`text-lg font-bold tracking-tight ${
          dark ? 'text-white' : 'text-slate-900'
        }`}
      >
        SaaSKit
      </span>
    </div>
  );
}

function Stat({ value, label }) {
  return (
    <div className="px-4 text-center">
      <dt className="text-2xl font-extrabold tracking-tight text-slate-900">
        {value}
      </dt>
      <dd className="mt-0.5 text-xs font-medium text-slate-500">{label}</dd>
    </div>
  );
}

function Check({ children }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-100 text-[10px] text-emerald-600">
        ✓
      </span>
      <span>{children}</span>
    </li>
  );
}

const FEATURES = [
  {
    icon: '🛡️',
    title: 'Document-level isolation',
    body: 'Every query is auto-scoped to the current tenant by a Mongoose plugin. Forget the scope and it fails closed — never leaks.',
  },
  {
    icon: '🌐',
    title: 'Wildcard subdomain routing',
    body: 'Each tenant lives at its own subdomain. The backend re-derives the tenant from the host on every request.',
  },
  {
    icon: '🔐',
    title: 'Per-tenant JWT auth',
    body: 'Tokens are bound to a tenant. Replay one against another workspace and it is rejected with a 403.',
  },
  {
    icon: '⚡',
    title: 'Instant onboarding',
    body: 'Pick a subdomain, check availability live, and your workspace is provisioned in a single insert.',
  },
  {
    icon: '👥',
    title: 'Shared emails, separate tenants',
    body: 'A compound unique index means the same email can belong to two different workspaces independently.',
  },
  {
    icon: '🧩',
    title: 'Dashboard shell ready',
    body: 'A responsive sidebar, top bar, and protected routes are in place — drop your features straight in.',
  },
];
