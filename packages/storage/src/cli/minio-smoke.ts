#!/usr/bin/env node
import { StorageConfig } from '../config.js';
import { S3StorageAdapter } from '../adapter.js';
import { createAwsS3Client, HeadBucketCommand, CreateBucketCommand } from '../s3-client.js';
import { ArtifactAlreadyExistsError } from '../errors.js';

/**
 * Opt-in CLI smoke verification for local MinIO container.
 * Requires explicit '--confirm-live-call' flag.
 * Never prints or leaks credentials or secrets.
 *
 * Usage:
 *   node --env-file=.env dist/cli/minio-smoke.js --confirm-live-call
 */
async function main() {
  const args = process.argv.slice(2);
  const confirmFlag = args.includes('--confirm-live-call');

  if (!confirmFlag) {
    console.log(`
[Opt-in MinIO Integration Smoke Test]
---------------------------------------------------------------
Notice: This script executes real S3 operations against the local MinIO service.
To prevent unintended network calls during test suites, this script
requires the explicit '--confirm-live-call' flag.

Prerequisites:
  1. docker compose -f compose.local.yaml up -d minio
  2. Local port 59000 listening

Usage:
  node --env-file=.env dist/cli/minio-smoke.js --confirm-live-call
---------------------------------------------------------------
    `);
    process.exit(0);
  }

  // Fail closed: load strictly from explicit environment without fallback credentials
  const config = StorageConfig.fromEnv();

  // Require explicit local service only; remote endpoints are strictly forbidden for opt-in test
  const parsedEndpoint = new URL(config.endpoint);
  const isLocalhost =
    parsedEndpoint.hostname === 'localhost' ||
    parsedEndpoint.hostname === '127.0.0.1' ||
    parsedEndpoint.hostname === '::1';

  if (!isLocalhost) {
    console.error(
      `[MinIO Smoke] FAILED: Opt-in local MinIO smoke test rejected non-local endpoint '${config.endpoint}'. Only local services are permitted.`
    );
    process.exit(1);
  }

  console.log(`[MinIO Smoke] Connecting to endpoint ${config.endpoint} (bucket: ${config.bucket})...`);

  // Ensure bucket exists
  const rawClient = createAwsS3Client(config);
  try {
    await rawClient.send(new HeadBucketCommand({ Bucket: config.bucket }));
  } catch (err) {
    const anyErr = err as Record<string, unknown> | null;
    if (anyErr?.name === 'NotFound' || (anyErr?.$metadata && (anyErr.$metadata as any).httpStatusCode === 404)) {
      console.log(`[MinIO Smoke] Creating bucket '${config.bucket}'...`);
      await rawClient.send(new CreateBucketCommand({ Bucket: config.bucket }));
    }
  }

  const adapter = new S3StorageAdapter({ config });
  const workspaceId = 'ws_smoke_minio';
  const testPayload = Buffer.from(`Liara DevOps MinIO Smoke Verification ${Date.now()}`, 'utf8');

  console.log('[MinIO Smoke] 1. Putting artifact...');
  const manifest = await adapter.putArtifact(
    {
      workspaceId,
      mimeType: 'text/plain',
      metadata: { environment: 'local-minio-smoke' },
    },
    testPayload
  );

  console.log(`[MinIO Smoke] Artifact created: ID=${manifest.artifactId}, Digest=${manifest.digest}, Size=${manifest.size}`);

  console.log('[MinIO Smoke] 2. Verifying immutability (IfNoneMatch: * duplicate put rejection)...');
  try {
    await adapter.putArtifact(
      {
        workspaceId,
        artifactId: manifest.artifactId,
        mimeType: 'text/plain',
      },
      Buffer.from('conflict overwrite attempt')
    );
    console.error('[MinIO Smoke] FAILED: Overwrite was not rejected!');
    process.exit(1);
  } catch (err) {
    if (err instanceof ArtifactAlreadyExistsError) {
      console.log('[MinIO Smoke] Immutability verified: duplicate put rejected with ArtifactAlreadyExistsError (409)');
    } else {
      console.error('[MinIO Smoke] Unexpected error during duplicate put:', (err as Error).message);
      process.exit(1);
    }
  }

  console.log('[MinIO Smoke] 3. Reading artifact and validating sha256 checksum...');
  const retrieved = await adapter.getArtifact({
    workspaceId,
    artifactId: manifest.artifactId,
  });

  if (retrieved.data.toString('utf8') !== testPayload.toString('utf8')) {
    console.error('[MinIO Smoke] FAILED: retrieved payload does not match original payload');
    process.exit(1);
  }
  if (retrieved.manifest.digest !== manifest.digest) {
    console.error('[MinIO Smoke] FAILED: checksum mismatch');
    process.exit(1);
  }
  console.log('[MinIO Smoke] Checksum and payload match 100%!');

  console.log('[MinIO Smoke] 4. Head artifact metadata...');
  const headMeta = await adapter.headArtifact({
    workspaceId,
    artifactId: manifest.artifactId,
  });
  if (!headMeta || headMeta.digest !== manifest.digest) {
    console.error('[MinIO Smoke] FAILED: headArtifact did not return matching metadata');
    process.exit(1);
  }
  console.log('[MinIO Smoke] Head metadata matches.');

  console.log('[MinIO Smoke] 5. Cleaning up test artifact...');
  await adapter.deleteArtifact({
    workspaceId,
    artifactId: manifest.artifactId,
  });

  const existsAfterDelete = await adapter.exists({
    workspaceId,
    artifactId: manifest.artifactId,
  });
  if (existsAfterDelete) {
    console.error('[MinIO Smoke] FAILED: artifact still exists after delete');
    process.exit(1);
  }

  console.log('[MinIO Smoke] Artifact deleted and confirmed gone.');
  console.log('✅ MinIO Local Integration Smoke Test PASSED!');
}

main().catch((err) => {
  console.error('[MinIO Smoke] Unhandled Error:', err.message);
  process.exit(1);
});
