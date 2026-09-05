import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { fetchMe } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import type { Role, User } from '../api/types.js';

/**
 * Who is signed in, according to the server.
 *
 * The single source of truth is `GET /auth/me`, not anything the client stored:
 * the session lives in an httpOnly cookie the JavaScript cannot read, so asking
 * the server is the only honest way to know. A 401 here means "nobody", which
 * is an answer rather than a failure — hence the `null` instead of an error.
 */

type AuthValue = {
  user: User | null;
  isLoading: boolean;
  /** True only when the signed-in user holds the role. Never a permission check. */
  hasRole: (role: Role) => boolean;
  refresh: () => Promise<unknown>;
  clear: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export const ME_QUERY_KEY = ['auth', 'me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: async () => {
      try {
        return (await fetchMe()).user;
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthenticated) return null;
        throw error;
      }
    },
    // Not signed in is a normal answer, so do not keep retrying it.
    retry: false,
    staleTime: 30_000,
  });

  const value = useMemo<AuthValue>(
    () => ({
      user: data ?? null,
      isLoading,
      hasRole: (role) => data?.role === role,
      refresh: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
      clear: () => queryClient.clear(),
    }),
    [data, isLoading, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
