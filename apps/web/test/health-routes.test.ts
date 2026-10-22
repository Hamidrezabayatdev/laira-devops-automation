import { describe, it, expect } from 'vitest';
import { GET as liveRoute } from '@/app/api/health/live/route';
import { GET as readyRoute } from '@/app/api/health/ready/route';

describe('Health & Readiness Probes', () => {
  it('GET /api/health/live returns immediate 200 with uptime', async () => {
    const res = await liveRoute();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
    expect(typeof data.uptimeSeconds).toBe('number');
  });

  it('GET /api/health/ready returns readiness and NEVER exposes credentials or connection strings', async () => {
    const res = await readyRoute();
    expect([200, 503]).toContain(res.status);

    const data = await res.json();
    expect(data.status).toBeDefined();
    expect(data.database).toBeDefined();
    expect(data.database.safeMessage).toBeDefined();

    // Convert response to string and ensure no passwords or credentials leaked
    const jsonStr = JSON.stringify(data);
    expect(jsonStr).not.toContain('password');
    expect(jsonStr).not.toContain('postgres://');
    expect(jsonStr).not.toContain('postgresql://');
    expect(jsonStr).not.toContain('SECRET');
  });
});
