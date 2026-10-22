import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  type S3ClientConfig,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
  type DeleteObjectCommandInput,
  type DeleteObjectCommandOutput,
  type HeadObjectCommandInput,
  type HeadObjectCommandOutput,
  type CreateBucketCommandInput,
  type CreateBucketCommandOutput,
  type HeadBucketCommandInput,
  type HeadBucketCommandOutput,
} from '@aws-sdk/client-s3';
import type { StorageConfig } from './config.js';

export {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  type S3ClientConfig,
  type PutObjectCommandInput,
  type PutObjectCommandOutput,
  type GetObjectCommandInput,
  type GetObjectCommandOutput,
  type DeleteObjectCommandInput,
  type DeleteObjectCommandOutput,
  type HeadObjectCommandInput,
  type HeadObjectCommandOutput,
  type CreateBucketCommandInput,
  type CreateBucketCommandOutput,
  type HeadBucketCommandInput,
  type HeadBucketCommandOutput,
};

export interface S3ClientOptions {
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

/**
 * Thin injected transport protocol matching @aws-sdk/client-s3 S3Client.
 * Allows seamless injection of MockS3Client or genuine S3Client without unknown casts.
 */
export interface S3ClientProtocol {
  send<TInput extends object, TOutput extends object>(
    command: { input: TInput; resolveMiddleware?: unknown },
    options?: S3ClientOptions
  ): Promise<TOutput>;
  destroy?: () => void;
}

/**
 * Creates genuine @aws-sdk/client-s3 S3Client instance.
 */
export function createAwsS3Client(config: StorageConfig): S3Client {
  const creds = config.credentials;
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });
}
