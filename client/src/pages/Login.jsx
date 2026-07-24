import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authApi, ApiError } from '../lib/api.js';
import { useAuth } from '../components/TenantContext.jsx';
import { rootUrl } from '../lib/useTenant.js';

export default function Login() {
  const { slug, setSession } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // No subdomain -> user is on the root domain, which has no login.
  if (!slug) return <NoTenant />;

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { user, tenant } = await authApi.login({ email, password });
      setSession(user, tenant);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Welcome back" subtitle={`Sign in to ${slug}`}>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500">
        No account?{' '}
        <Link to="/register" className="font-semibold text-brand-700">
          Create one
        </Link>
      </p>
    </AuthShell>
  );
}

export function AuthShell({ title, subtitle, children }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-brand-600 font-bold text-white">
            S
          </div>
          <h1 className="mt-4 text-2xl font-bold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
        </div>
        <div className="card">{children}</div>
      </div>
    </div>
  );
}

function NoTenant() {
  return (
    <AuthShell
      title="Pick a workspace"
      subtitle="Login happens on your tenant's subdomain"
    >
      <p className="text-sm text-slate-600">
        You're on the root domain. Head to your workspace URL, e.g.{' '}
        <code className="rounded bg-slate-100 px-1">acme.app.local:5173</code>, or{' '}
        <a href={rootUrl('/')} className="font-semibold text-brand-700">
          create a new workspace
        </a>
        .
      </p>
    </AuthShell>
  );
}
