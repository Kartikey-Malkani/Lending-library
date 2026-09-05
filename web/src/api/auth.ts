import { apiRequest } from './client.js';
import type { User } from './types.js';

export function fetchMe(): Promise<{ user: User }> {
  return apiRequest('/auth/me');
}

export function login(email: string, password: string): Promise<{ user: User }> {
  return apiRequest('/auth/login', { method: 'POST', body: { email, password } });
}

export function logout(): Promise<void> {
  return apiRequest('/auth/logout', { method: 'POST' });
}
