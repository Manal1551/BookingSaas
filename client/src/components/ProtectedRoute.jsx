import { Navigate } from 'react-router-dom';
import { useAuth } from './TenantContext.jsx';

/**
 * Gates routes behind a valid session. While /api/auth/me is in flight we show
 * a spinner; if there is no session we redirect to /login.
 */
export default function ProtectedRoute({ children }) {
  const { isAuthed, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      </div>
    );
  }

  if (!isAuthed) return <Navigate to="/login" replace />;
  return children;
}
