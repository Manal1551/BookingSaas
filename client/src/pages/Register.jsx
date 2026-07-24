import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authApi, ApiError } from '../lib/api.js';
import { useAuth } from '../components/TenantContext.jsx';
import { AuthShell } from './Login.jsx';

export default function Register() {
  const { slug, setSession } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  if (!slug) {
    return (
      <AuthShell title="Create a workspace first">
        <p className="text-sm text-slate-600">
          Registration happens on a tenant subdomain. Create your workspace on
          the main site, then you'll be redirected here.
        </p>
      </AuthShell>
    );
  }

  function update(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  function validate() {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      errs.email = 'Enter a valid email';
    if (form.password.length < 8)
      errs.password = 'At least 8 characters';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    if (!validate()) return;
    setSubmitting(true);
    try {
      const { user, tenant } = await authApi.register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      setSession(user, tenant);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed');
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Create your account" subtitle={`Joining ${slug}`}>
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <Field
          id="name"
          label="Full name"
          value={form.name}
          onChange={update('name')}
          error={fieldErrors.name}
          autoComplete="name"
        />
        <Field
          id="email"
          label="Email"
          type="email"
          value={form.email}
          onChange={update('email')}
          error={fieldErrors.email}
          autoComplete="email"
        />
        <Field
          id="password"
          label="Password"
          type="password"
          value={form.password}
          onChange={update('password')}
          error={fieldErrors.password}
          autoComplete="new-password"
          hint="Minimum 8 characters"
        />

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-slate-500">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-brand-700">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}

function Field({ id, label, error, hint, ...props }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" {...props} />
      {error ? (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}
