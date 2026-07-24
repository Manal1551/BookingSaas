import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi, ApiError } from '../lib/api.js';
import { useTenant } from '../lib/useTenant.js';

/**
 * Holds the current auth session (user + tenant) hydrated from /api/auth/me.
 * `slug` is the subdomain label; `tenant` is what the backend confirmed.
 */
const AuthContext = createContext(null);

export function TenantProvider({ children }) {
  const slug = useTenant();
  const [user, setUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);

  const hydrate = useCallback(async () => {
    setLoading(true);
    try {
      const { user: u, tenant: t } = await authApi.me();
      setUser(u);
      setTenant(t);
    } catch (err) {
      // 401/403 simply means "not logged in on this tenant".
      if (!(err instanceof ApiError)) console.error(err);
      setUser(null);
      setTenant(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setUser(null);
      setTenant(null);
    }
  }, []);

  const value = {
    slug,
    user,
    tenant,
    loading,
    isAuthed: Boolean(user),
    setSession: (u, t) => {
      setUser(u);
      setTenant(t);
    },
    hydrate,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within TenantProvider');
  return ctx;
}
