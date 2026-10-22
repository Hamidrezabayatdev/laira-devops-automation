export function isIsolatedTestDatabase(testUrl, applicationUrl) {
  if (!testUrl || testUrl === applicationUrl) return false;
  try {
    const target = new URL(testUrl);
    if (applicationUrl) {
      try {
        const application = new URL(applicationUrl);
        const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
        const sameHost = target.hostname === application.hostname ||
          (localHosts.has(target.hostname) && localHosts.has(application.hostname));
        if (sameHost && (target.port || '5432') === (application.port || '5432') &&
            target.pathname === application.pathname) return false;
      } catch {
        return false;
      }
    }
    // Query parameters can override connection fields in database drivers.
    // This deliberately supports only the simple local development URL form.
    return (
      ['postgres:', 'postgresql:'].includes(target.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
      /^\/[a-zA-Z0-9_-]+_test$/.test(target.pathname) &&
      target.search === '' &&
      target.hash === ''
    );
  } catch {
    return false;
  }
}
