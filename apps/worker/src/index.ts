import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppWorker } from './worker.js';
import { safeErrorMessage } from './outbox-poller.js';

export * from './config.js';
export * from './worker.js';
export * from './heartbeat.js';
export * from './outbox-poller.js';
export * from './handlers/index.js';

export async function runWorkerProcess() {
  const worker = new AppWorker();
  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    try {
      await worker.stop();
      process.exit(0);
    } catch (err) {
      console.error(`Shutdown error: ${safeErrorMessage(err)}`);
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  try {
    await worker.start();
  } catch (err) {
    console.error('Fatal worker startup error:', safeErrorMessage(err));
    process.exit(1);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  runWorkerProcess();
}
