import type { Request } from 'express';

/**
 * Resolves the caller's IP address.
 *
 * This exists because getting it wrong is a rate-limit bypass, and behind Cloudflare
 * the obvious approach is the wrong one.
 *
 * **Why not `X-Forwarded-For` with Express's `trust proxy`.** Cloudflare puts the
 * user's address **first** in `X-Forwarded-For` and its own after it, while Express's
 * hop count reads from the *right*. So `trust proxy = 1` behind a Cloudflare tunnel
 * makes `req.ip` the Cloudflare edge address - every user in the world sharing one
 * bucket. Worse, Cloudflare *appends* to a client-supplied `X-Forwarded-For` rather
 * than replacing it, and cloudflared has a standing bug where that produces a wrong
 * value at the origin, so the header is partly attacker-controlled.
 *
 * **Why `CF-Connecting-IP` is safe, but only behind Cloudflare.** Cloudflare sets and
 * overwrites it, so a client cannot forge it - *provided* Cloudflare is actually in
 * front. With nothing in front, anyone may send `CF-Connecting-IP: <anything>` and mint
 * a fresh rate-limit budget per request. That is why the header is never read unless
 * `CLIENT_IP_HEADER` explicitly names it: trusting a header is a deployment fact, not
 * something code can infer.
 */

/**
 * @param headerName header to read, or null to use the socket address.
 * @returns the caller's address, or null when nothing usable is available.
 */
export function resolveClientIp(
  request: Request,
  headerName: string | null,
): string | null {
  if (!headerName) {
    return request.ip ?? null;
  }

  const raw = request.headers[headerName];
  const value = Array.isArray(raw) ? raw[0] : raw;

  // Falls back to the socket address rather than skipping the limit. Behind a tunnel
  // that means one shared bucket, which is too strict rather than absent - the
  // failure mode of a misconfiguration should be refusing too much, not counting
  // nothing.
  if (typeof value !== 'string') {
    return request.ip ?? null;
  }

  // `CF-Connecting-IP` is a single address, but a proxy chain header may be a list;
  // the left-most entry is the client in both conventions.
  const first = value.split(',')[0]?.trim();

  return first && isPlausibleAddress(first) ? first : (request.ip ?? null);
}

/**
 * A cheap sanity check, not a validator.
 *
 * The value becomes a rate-limit bucket key, so the only real requirement is that it
 * cannot be padded into unbounded distinct keys. Parsing IPv4 and IPv6 properly would
 * be more code and would reject legitimate forms (zone ids, IPv4-mapped IPv6) for no
 * gain here.
 */
function isPlausibleAddress(value: string): boolean {
  return (
    value.length > 0 && value.length <= 45 && /^[0-9a-fA-F:.%[\]]+$/.test(value)
  );
}
