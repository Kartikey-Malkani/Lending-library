import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { logout } from '../api/auth.js';
import { useAuth } from '../auth/AuthProvider.js';

/**
 * The app shell and its navigation.
 *
 * Links a member cannot use are not rendered — but that is tidiness, not
 * security. Every one of those pages calls an endpoint the server guards by
 * capability, and typing the URL directly gets the same refusal.
 */
export function Layout() {
  const { user, clear } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      // The server has destroyed the session row; drop every cached response so
      // the next user does not briefly see the previous one's data.
      clear();
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });

  const isLibrarian = user?.role === 'librarian';

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__brand">
          <strong>Lending Library</strong>
        </div>

        <nav className="app__nav" aria-label="Main">
          <NavLink to="/catalogue">Catalogue</NavLink>
          <NavLink to="/loans">Loans</NavLink>
          {isLibrarian && <NavLink to="/my-items">My items</NavLink>}
          {isLibrarian && <NavLink to="/import">Import</NavLink>}
        </nav>

        <div className="app__user">
          {user && (
            <>
              <span className="app__whoami">
                {user.name} <span className="role-tag">{user.role}</span>
              </span>
              <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
                {signOut.isPending ? 'Signing out…' : 'Sign out'}
              </button>
            </>
          )}
        </div>
      </header>

      <main className="app__main">
        <Outlet />
      </main>
    </div>
  );
}
