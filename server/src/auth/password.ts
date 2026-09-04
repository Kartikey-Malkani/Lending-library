import bcrypt from 'bcryptjs';
import { config } from '../config.js';

/**
 * Password hashing.
 *
 * bcrypt rather than a plain digest: passwords need a deliberately slow,
 * salted KDF so a stolen `users` table is not a stolen password list.
 */

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, config.bcryptCost);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * A real bcrypt hash of a value nobody can log in with.
 *
 * Used when login is attempted for an address that has no account: comparing
 * against this costs the same as comparing against a real hash, so an attacker
 * cannot tell registered addresses from unregistered ones by timing the
 * response. Returning an identical 401 body is only half the defence — without
 * this, the "no such user" path returns measurably faster.
 *
 * Generated once at module load at the configured cost, so it tracks whatever
 * work factor real hashes use.
 */
const DUMMY_HASH_PROMISE = hashPassword('password-that-is-never-valid');

export async function wasteTimeLikeAPasswordCheck(plaintext: string): Promise<void> {
  await verifyPassword(plaintext, await DUMMY_HASH_PROMISE);
}
