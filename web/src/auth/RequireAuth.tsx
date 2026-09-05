import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { Role } from '../api/types.js';
import { useAuth } from './AuthProvider.js';

/**
 * Keeps unauthenticated visitors out of the app shell and sends them to login,
 * remembering where they were going.
 *
 * This is navigation, not authorization. Every endpoint behind these pages is
 * guarded on the server; if this component were deleted the data would still be
 * refused. It exists so the app does not show a member a page of 403s.
 */
export function RequireAuth({ children, role }: { children: ReactNode; role?: Role }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <p className="state">Checking your session…</p>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;

  if (role && user.role !== role) {
    return (
      <div className="state state--error" role="alert">
        <h2>Not available to your account</h2>
        <p>This page is for {role}s. You are signed in as a {user.role}.</p>
      </div>
    );
  }

  return <>{children}</>;
}
