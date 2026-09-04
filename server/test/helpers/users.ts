import type { Role, User } from '@prisma/client';
import { hashPassword } from '../../src/auth/password.js';
import { prisma } from '../../src/db.js';

/**
 * Test fixtures for accounts.
 *
 * Passwords are hashed through the real helper, so the login path under test is
 * the one the seed and any future account creation would produce — not a
 * shortcut that would pass while real logins failed.
 */

export const LIBRARIAN_PASSWORD = 'Librarian123!';
export const MEMBER_PASSWORD = 'Member123!';

export async function createUser(options: {
  email: string;
  role: Role;
  password: string;
  name?: string;
}): Promise<User> {
  return prisma.user.create({
    data: {
      email: options.email.toLowerCase(),
      name: options.name ?? options.email,
      role: options.role,
      passwordHash: await hashPassword(options.password),
    },
  });
}

export function createLibrarian(email = 'librarian@test.local'): Promise<User> {
  return createUser({ email, role: 'librarian', password: LIBRARIAN_PASSWORD, name: 'Test Librarian' });
}

export function createMember(email = 'member@test.local'): Promise<User> {
  return createUser({ email, role: 'member', password: MEMBER_PASSWORD, name: 'Test Member' });
}
