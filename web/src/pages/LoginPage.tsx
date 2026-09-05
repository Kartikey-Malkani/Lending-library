import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { login } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { useAuth } from '../auth/AuthProvider.js';
import { ErrorState } from '../components/DataState.js';

export function LoginPage() {
  const { user, isLoading, refresh } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: () => refresh(),
  });

  if (isLoading) return <p className="state">Checking your session…</p>;
  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/catalogue'} replace />;
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    signIn.mutate();
  }

  return (
    <div className="login">
      <h1>Sign in</h1>

      <form onSubmit={onSubmit} className="form">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button type="submit" className="primary" disabled={signIn.isPending}>
          {signIn.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {signIn.isError && (
        <ErrorState
          error={signIn.error}
          title={
            signIn.error instanceof ApiError && signIn.error.status === 401
              ? 'Could not sign in'
              : 'Something went wrong'
          }
        />
      )}
    </div>
  );
}
