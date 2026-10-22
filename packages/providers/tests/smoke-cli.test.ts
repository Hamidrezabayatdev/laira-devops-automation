import { describe, it } from 'vitest';
import assert from 'node:assert';
import { runSmokeCli } from '../src/cli/smoke.ts';

describe('Smoke Opt-In CLI', () => {
  it('runs successfully in safe fixture simulation mode without live flags', async () => {
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (...args: any[]) => output.push(args.join(' '));

    try {
      const exitCode = await runSmokeCli([]);
      assert.strictEqual(exitCode, 0);

      const text = output.join('\n');
      assert.strictEqual(text.includes('FIXTURE SIMULATION'), true);
      assert.strictEqual(text.includes('Model: openai/gpt-5.4-mini (no runtime fallback)'), true);
      assert.strictEqual(text.includes('Request 1/2'), true);
      assert.strictEqual(text.includes('Request 2/2'), true);
      assert.strictEqual(text.includes('Status: SUCCESS'), true);
      assert.strictEqual(text.includes('Secrets Check: PASS'), true);
      assert.strictEqual(text.includes('export BOX_API_KEY'), true);
    } finally {
      console.log = originalLog;
    }
  });

  it('rejects live invocation when --confirm-live-call flag is missing', async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: any[]) => errors.push(args.join(' '));

    try {
      const exitCode = await runSmokeCli(['--live']);
      assert.strictEqual(exitCode, 1);

      const text = errors.join('\n');
      assert.strictEqual(text.includes('SAFETY GATE'), true);
      assert.strictEqual(text.includes('--confirm-live-call'), true);
    } finally {
      console.error = originalError;
    }
  });

  it('rejects passing --api-key in command line arguments to prevent process listing leaks', async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: any[]) => errors.push(args.join(' '));

    try {
      const exitCode = await runSmokeCli(['--api-key', 'secret-key-that-would-leak']);
      assert.strictEqual(exitCode, 1);

      const text = errors.join('\n');
      assert.strictEqual(text.includes('SECURITY ERROR'), true);
      assert.strictEqual(text.includes('ps aux'), true);
      assert.strictEqual(text.includes('secret-key-that-would-leak'), false); // Must not echo the key!
    } finally {
      console.error = originalError;
    }
  });

  it('rejects live invocation when BOX_API_KEY environment variable is missing', async () => {
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: any[]) => errors.push(args.join(' '));

    const originalKey = process.env.BOX_API_KEY;
    delete process.env.BOX_API_KEY;
    delete process.env.BOXAPI_API_KEY;

    try {
      const exitCode = await runSmokeCli(['--live', '--confirm-live-call']);
      assert.strictEqual(exitCode, 1);

      const text = errors.join('\n');
      assert.strictEqual(text.includes('BOX_API_KEY environment variable is required'), true);
    } finally {
      if (originalKey) process.env.BOX_API_KEY = originalKey;
      console.error = originalError;
    }
  });
});
