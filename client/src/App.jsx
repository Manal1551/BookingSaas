import { Routes, Route, Navigate } from 'react-router-dom';
import { useTenant } from './lib/useTenant.js';
import { TenantProvider } from './components/TenantContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Bookings from './pages/Bookings.jsx';
import Pricing from './pages/Pricing.jsx';
import Billing from './pages/Billing.jsx';

/**
 * Routing depends on whether we are on the ROOT domain or a TENANT subdomain:
 *  - Root domain (app.local)   -> marketing + signup only.
 *  - Tenant subdomain (acme.*) -> auth + dashboard app.
 */
export default function App() {
  const slug = useTenant();

  if (!slug) {
    // Root domain: no tenant, no auth context needed.
    return (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <TenantProvider>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/bookings"
          element={
            <ProtectedRoute>
              <Bookings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/plans"
          element={
            <ProtectedRoute>
              <Pricing />
            </ProtectedRoute>
          }
        />
        <Route
          path="/dashboard/billing"
          element={
            <ProtectedRoute>
              <Billing />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </TenantProvider>
  );
}
