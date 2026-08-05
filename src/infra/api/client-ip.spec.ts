import type { Request } from 'express';

import { resolveClientIp } from './client-ip';

function request(
  headers: Record<string, string | string[]>,
  socketIp = '127.0.0.1',
): Request {
  return { headers, ip: socketIp } as unknown as Request;
}

describe('resolveClientIp', () => {
  describe('with no header configured', () => {
    it('uses the socket address', () => {
      expect(resolveClientIp(request({}, '203.0.113.7'), null)).toBe(
        '203.0.113.7',
      );
    });

    it('ignores CF-Connecting-IP even when present', () => {
      // The bypass this guards against: with nothing in front of the service, any
      // caller can send this header and mint a fresh rate-limit budget per request.
      // Trusting a header is a deployment fact, not something to infer from its
      // presence.
      const spoofed = request(
        { 'cf-connecting-ip': '198.51.100.1' },
        '203.0.113.7',
      );

      expect(resolveClientIp(spoofed, null)).toBe('203.0.113.7');
    });

    it('ignores X-Forwarded-For even when present', () => {
      const spoofed = request(
        { 'x-forwarded-for': '198.51.100.1' },
        '203.0.113.7',
      );

      expect(resolveClientIp(spoofed, null)).toBe('203.0.113.7');
    });
  });

  describe('behind a Cloudflare tunnel', () => {
    it('reads the caller from CF-Connecting-IP, not the tunnel socket', () => {
      // cloudflared connects from loopback, so without this every user on earth
      // would share the 127.0.0.1 bucket.
      const proxied = request(
        {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '203.0.113.7, 172.71.0.1',
        },
        '127.0.0.1',
      );

      expect(resolveClientIp(proxied, 'cf-connecting-ip')).toBe('203.0.113.7');
    });

    it('is not fooled by a client-supplied X-Forwarded-For', () => {
      // Cloudflare *appends* to a client's X-Forwarded-For rather than replacing it,
      // and cloudflared has a standing bug that can corrupt the result - which is
      // exactly why the forwarded chain is not what we read.
      const attacker = request(
        {
          'x-forwarded-for': '1.2.3.4, 203.0.113.7, 172.71.0.1',
          'cf-connecting-ip': '203.0.113.7',
        },
        '127.0.0.1',
      );

      expect(resolveClientIp(attacker, 'cf-connecting-ip')).toBe('203.0.113.7');
    });

    it('falls back to the socket address when the header is missing', () => {
      // Too strict rather than absent: a misconfiguration should refuse too much,
      // never count nothing.
      expect(
        resolveClientIp(request({}, '127.0.0.1'), 'cf-connecting-ip'),
      ).toBe('127.0.0.1');
    });

    it('takes the left-most entry of a list', () => {
      const chained = request(
        { 'x-real-ip': '203.0.113.7, 172.71.0.1' },
        '127.0.0.1',
      );

      expect(resolveClientIp(chained, 'x-real-ip')).toBe('203.0.113.7');
    });

    it('takes the first value when the header is repeated', () => {
      const repeated = request(
        { 'cf-connecting-ip': ['203.0.113.7', '198.51.100.1'] },
        '127.0.0.1',
      );

      expect(resolveClientIp(repeated, 'cf-connecting-ip')).toBe('203.0.113.7');
    });

    it('handles IPv6', () => {
      const v6 = request(
        { 'cf-connecting-ip': '2001:db8::8a2e:370:7334' },
        '127.0.0.1',
      );

      expect(resolveClientIp(v6, 'cf-connecting-ip')).toBe(
        '2001:db8::8a2e:370:7334',
      );
    });
  });

  describe('rejecting unusable values', () => {
    it('falls back when the value is not address-shaped', () => {
      // The value becomes a rate-limit bucket key. Arbitrary text would let a caller
      // create unbounded distinct keys, which is a bypass and a way to grow the
      // counter table.
      for (const bogus of [
        'not-an-ip',
        '<script>',
        'a'.repeat(200),
        '',
        '   ',
      ]) {
        expect(
          resolveClientIp(
            request({ 'cf-connecting-ip': bogus }, '127.0.0.1'),
            'cf-connecting-ip',
          ),
        ).toBe('127.0.0.1');
      }
    });

    it('returns null when there is nothing at all', () => {
      const nothing = { headers: {} } as unknown as Request;

      expect(resolveClientIp(nothing, 'cf-connecting-ip')).toBeNull();
      expect(resolveClientIp(nothing, null)).toBeNull();
    });
  });
});
