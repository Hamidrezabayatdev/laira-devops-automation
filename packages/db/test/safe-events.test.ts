import { describe, it, expect } from 'vitest';
import { validateSafeEventPayload } from '../src/schema/events.js';

describe('Safe Event Payloads Validation', () => {
  it('validates supported event types with typed fields', () => {
    const startPayload = validateSafeEventPayload('run_started', {
      step: 'init',
      message: 'Run initiated',
    });
    expect(startPayload).toEqual({ step: 'init', message: 'Run initiated' });

    const progressPayload = validateSafeEventPayload('step_progress', {
      step: 'inspect',
      progress: 50,
      message: 'Inspecting services',
    });
    expect(progressPayload.progress).toBe(50);

    const fixturePayload = validateSafeEventPayload('fixture_inspection', {
      resourceCount: 3,
      verified: true,
      summary: 'Mock check OK',
    });
    expect(fixturePayload.verified).toBe(true);
  });

  it('rejects arbitrary undeclared payload keys to prevent secret leaks', () => {
    expect(() => {
      validateSafeEventPayload('run_started', {
        step: 'init',
        message: 'Started',
        secret_token: 'should-be-rejected-12345',
      });
    }).toThrow();

    expect(() => {
      validateSafeEventPayload('fixture_inspection', {
        resourceCount: 3,
        verified: true,
        summary: 'Mock check',
        apiKey: 'boxapi-secret',
      });
    }).toThrow();
  });

  it('rejects unsupported event types', () => {
    expect(() => {
      validateSafeEventPayload('arbitrary_custom_event', {
        data: 'anything',
      });
    }).toThrow(/Unsupported event type/);
  });
});
