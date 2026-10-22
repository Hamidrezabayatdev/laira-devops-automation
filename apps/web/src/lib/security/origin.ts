/**
 * Same-origin and mutation request verification helper.
 * Validates Origin / Referer / Sec-Fetch-Site to prevent CSRF on state-changing browser mutations.
 */

export interface OriginVerificationResult {
  valid: boolean;
  reason?: string;
  origin?: string;
}

export function verifyRequestOrigin(request: Request): OriginVerificationResult {
  const method = request.method.toUpperCase();
  // Safe idempotent methods do not require origin checks
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return { valid: true };
  }

  // Sec-Fetch-Site check (standard modern browser header)
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && !['same-origin', 'same-site', 'none'].includes(secFetchSite)) {
    return {
      valid: false,
      reason: 'Untrusted Sec-Fetch-Site',
    };
  }

  const rawOrigin = request.headers.get('origin');
  const rawReferer = request.headers.get('referer');

  // Both origin and referer missing -> fail closed (no UA bypass)
  if (!rawOrigin && !rawReferer) {
    return {
      valid: false,
      reason: 'Missing Origin and Referer',
    };
  }

  // Determine trusted server origin (exact scheme + host + effective port)
  // Configured AUTH_URL takes precedence (with NEXTAUTH_URL / APP_URL compatibility).
  // If configured URL is malformed, fail closed immediately without unsafe fallback.
  let trustedOrigin: string;
  const configured =
    process.env.AUTH_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.APP_URL;

  if (configured) {
    try {
      decodeURI(configured);
      const configuredUrl = new URL(configured);
      if (!['http:', 'https:'].includes(configuredUrl.protocol)) {
        return { valid: false, reason: 'Invalid configured server origin' };
      }
      trustedOrigin = configuredUrl.origin;
    } catch {
      return { valid: false, reason: 'Malformed configured server origin' };
    }
  } else {
    try {
      decodeURI(request.url);
      const requestUrl = new URL(request.url);
      if (!['http:', 'https:'].includes(requestUrl.protocol)) {
        return { valid: false, reason: 'Invalid request origin' };
      }
      trustedOrigin = requestUrl.origin;
    } catch {
      return { valid: false, reason: 'Malformed request URL' };
    }
  }

  // Validate candidate origin
  let candidateOrigin: string | null = null;

  if (rawOrigin) {
    try {
      decodeURI(rawOrigin);
      const parsedOrigin = new URL(rawOrigin);
      if (parsedOrigin.origin === 'null' || !['http:', 'https:'].includes(parsedOrigin.protocol)) {
        return { valid: false, reason: 'Invalid Origin header' };
      }
      candidateOrigin = parsedOrigin.origin;
    } catch {
      return { valid: false, reason: 'Malformed Origin header' };
    }
  }

  if (rawReferer) {
    let parsedRefOrigin: string | null = null;
    try {
      decodeURI(rawReferer);
      const parsedRef = new URL(rawReferer);
      if (parsedRef.origin === 'null' || !['http:', 'https:'].includes(parsedRef.protocol)) {
        return { valid: false, reason: 'Invalid Referer header' };
      }
      parsedRefOrigin = parsedRef.origin;
    } catch {
      return { valid: false, reason: 'Malformed Referer header' };
    }

    if (!candidateOrigin) {
      candidateOrigin = parsedRefOrigin;
    }
  }

  if (!candidateOrigin) {
    return { valid: false, reason: 'Invalid Origin/Referer' };
  }

  // Exact comparison: scheme + host + effective port
  if (candidateOrigin === trustedOrigin) {
    return { valid: true, origin: candidateOrigin };
  }

  return {
    valid: false,
    reason: 'Cross-origin mutation rejected',
    origin: candidateOrigin,
  };
}
