import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { verifyRequestOrigin } from '@/lib/security/origin';
import { generateCsrfToken, verifyCsrfToken } from '@/lib/security/csrf';

describe('Same-Origin & CSRF Security Helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.APP_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('verifyRequestOrigin', () => {
    it('allows GET, HEAD, and OPTIONS requests unconditionally', () => {
      const getReq = new Request('http://localhost:3000/api/runs', { method: 'GET' });
      expect(verifyRequestOrigin(getReq).valid).toBe(true);

      const headReq = new Request('http://localhost:3000/api/runs', { method: 'HEAD' });
      expect(verifyRequestOrigin(headReq).valid).toBe(true);

      const optReq = new Request('http://localhost:3000/api/runs', { method: 'OPTIONS' });
      expect(verifyRequestOrigin(optReq).valid).toBe(true);
    });

    it('rejects cross-site Sec-Fetch-Site on browser mutations with static reason', () => {
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'cross-site',
          origin: 'https://attacker.com',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Untrusted Sec-Fetch-Site');
    });

    it('allows same-origin mutations matching the request origin exactly', () => {
      const postReq = new Request('https://console.liara.ir/api/runs', {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'same-origin',
          origin: 'https://console.liara.ir',
        },
      });
      expect(verifyRequestOrigin(postReq).valid).toBe(true);
    });

    it('allows localhost origin when target request URL matches localhost and port exactly', () => {
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
        },
      });
      expect(verifyRequestOrigin(postReq).valid).toBe(true);
    });

    it('rejects HTTPS downgrade mismatch', () => {
      // Server is HTTPS, caller attempts HTTP downgrade
      const postReq = new Request('https://console.liara.ir/api/runs', {
        method: 'POST',
        headers: {
          origin: 'http://console.liara.ir',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Cross-origin mutation rejected');
    });

    it('rejects port mismatch on localhost without broad localhost exception', () => {
      // Port 3001 attempting mutation against port 3000
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3001',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Cross-origin mutation rejected');
    });

    it('rejects localhost origins when production AUTH_URL is configured', () => {
      process.env.AUTH_URL = 'https://console.liara.ir';
      const postReq = new Request('https://console.liara.ir/api/runs', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Cross-origin mutation rejected');
    });

    it('rejects malformed percent-encoded Referer without throwing', () => {
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          referer: 'http://localhost:3000/runs/%%%',
        },
      });
      let result: ReturnType<typeof verifyRequestOrigin> | undefined;
      expect(() => {
        result = verifyRequestOrigin(postReq);
      }).not.toThrow();
      expect(result?.valid).toBe(false);
      expect(result?.reason).toBe('Malformed Referer header');
    });

    it('rejects malformed percent-encoded Origin without throwing', () => {
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000/%%%',
        },
      });
      let result: ReturnType<typeof verifyRequestOrigin> | undefined;
      expect(() => {
        result = verifyRequestOrigin(postReq);
      }).not.toThrow();
      expect(result?.valid).toBe(false);
      expect(result?.reason).toBe('Malformed Origin header');
    });

    it('rejects raw non-URL %%% Origin and Referer without throwing', () => {
      const badOriginReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { origin: '%%%' },
      });
      expect(() => {
        const res = verifyRequestOrigin(badOriginReq);
        expect(res.valid).toBe(false);
      }).not.toThrow();

      const badRefReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: { referer: '%%%' },
      });
      expect(() => {
        const res = verifyRequestOrigin(badRefReq);
        expect(res.valid).toBe(false);
      }).not.toThrow();
    });

    it('rejects opaque "null" Origin', () => {
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          origin: 'null',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Malformed Origin header');
    });

    it('allows valid exact origin extracted from Referer when Origin is absent', () => {
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          referer: 'http://localhost:3000/dashboard/runs/123',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(true);
      expect(result.origin).toBe('http://localhost:3000');
    });

    it('rejects cross-origin Referer when Origin is absent', () => {
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          referer: 'http://malicious.com/exploit',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Cross-origin mutation rejected');
    });

    it('fails closed when both Origin and Referer are absent even for non-browser UA', () => {
      // Non-browser UA (e.g. curl/custom script) without origin headers must fail closed on mutations
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          'user-agent': 'curl/8.4.0',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Missing Origin and Referer');
    });

    it('fails closed when configured AUTH_URL is malformed without unsafe fallback', () => {
      process.env.AUTH_URL = 'http://:not-a-valid-url';
      const postReq = new Request('http://localhost:3000/api/runs', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
        },
      });
      const result = verifyRequestOrigin(postReq);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Malformed configured server origin');
    });
  });

  describe('CSRF Token Generation and Verification', () => {
    const sessionId = 'session_12345_owner';

    it('generates and verifies valid CSRF token', () => {
      const token = generateCsrfToken(sessionId);
      expect(token).toBeDefined();
      expect(verifyCsrfToken(sessionId, token)).toBe(true);
    });

    it('rejects token when session ID does not match', () => {
      const token = generateCsrfToken(sessionId);
      expect(verifyCsrfToken('different_session_999', token)).toBe(false);
    });

    it('rejects tampered token signature of equal length', () => {
      const token = generateCsrfToken(sessionId);
      const [ts, sig] = token.split('.');
      expect(sig).toBeDefined();
      // Alter the signature by replacing the last char with another hex digit of equal length
      const lastChar = sig!.slice(-1) === 'a' ? 'b' : 'a';
      const tampered = `${ts}.${sig!.slice(0, -1)}${lastChar}`;
      expect(verifyCsrfToken(sessionId, tampered)).toBe(false);
    });

    it('rejects unequal-length signature without throwing RangeError', () => {
      const token = generateCsrfToken(sessionId);
      const [ts] = token.split('.');
      // Provided signature is shorter (e.g. 8 bytes vs 64 hex chars)
      const shortSigToken = `${ts}.abcdef`;
      expect(() => {
        const valid = verifyCsrfToken(sessionId, shortSigToken);
        expect(valid).toBe(false);
      }).not.toThrow();

      // Provided signature is longer
      const longSigToken = `${ts}.${'a'.repeat(128)}`;
      expect(() => {
        const valid = verifyCsrfToken(sessionId, longSigToken);
        expect(valid).toBe(false);
      }).not.toThrow();
    });

    it('rejects future timestamp tokens', () => {
      const futureTimestamp = (Date.now() + 100000).toString();
      const crypto = require('crypto');
      const secret = process.env.AUTH_SECRET || 'liara-csrf-fallback-development-key';
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${sessionId}:${futureTimestamp}`)
        .digest('hex');
      const futureToken = `${futureTimestamp}.${sig}`;

      expect(verifyCsrfToken(sessionId, futureToken)).toBe(false);
    });

    it('rejects expired token', () => {
      const token = generateCsrfToken(sessionId);
      // maxAge = -1ms (already expired)
      expect(verifyCsrfToken(sessionId, token, -1)).toBe(false);
    });
  });
});
