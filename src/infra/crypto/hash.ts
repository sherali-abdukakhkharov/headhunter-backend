import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Secret hashing for OTP codes and refresh tokens.
 *
 * **Why HMAC-SHA256 and not argon2/bcrypt.** A slow KDF exists to make guessing
 * a *low-entropy* secret expensive. Refresh tokens here are 256 bits of CSPRNG
 * output, so guessing is already infeasible and a KDF would only add latency to
 * every refresh. OTP codes *are* low entropy - six digits - but they live for
 * minutes, allow a handful of attempts, and are hashed under a server-side
 * pepper that never enters the database. A stolen dump therefore cannot brute
 * force them offline without also stealing the application secret.
 *
 * The pepper is `TOKEN_HASH_PEPPER`, validated at boot. Rotating it invalidates
 * every live OTP and refresh token, which is the intended blast radius.
 */

/** Hashes a secret under the pepper. Hex-encoded, safe to store. */
export function hashSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

/**
 * Constant-time comparison of a candidate secret against a stored hash.
 *
 * Plain `===` on the hashes leaks timing information about how many leading
 * characters matched, which is enough to reconstruct a hash byte by byte.
 */
export function verifySecret(
  candidate: string,
  storedHash: string,
  pepper: string,
): boolean {
  const candidateHash = Buffer.from(hashSecret(candidate, pepper), 'hex');
  const expected = Buffer.from(storedHash, 'hex');

  // timingSafeEqual throws on length mismatch, which a malformed stored hash
  // would cause. Different lengths cannot be equal anyway.
  if (candidateHash.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidateHash, expected);
}

/** A refresh token: 256 bits of CSPRNG output, URL-safe. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * A numeric OTP code of the configured length, zero-padded.
 *
 * `randomInt` rather than `Math.random`: the code is a credential, and
 * `Math.random` is neither cryptographically secure nor seeded unpredictably.
 * Zero-padding matters - dropping leading zeros would shrink the keyspace and
 * make some codes shorter than advertised.
 */
export function generateOtpCode(length: number): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, '0');
}
