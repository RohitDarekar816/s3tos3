import {
  S3Client,
  ListObjectsV2Command,
  HeadBucketCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export function buildS3Client(config) {
  return new S3Client({
    region: config.region || 'us-east-1',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Built-in adaptive retry: exponential backoff + circuit breaker
    // Handles S3 throttling (503 Slow Down), 429, and transient network errors
    maxAttempts: 5,
    retryMode: 'adaptive',
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
  });
}

export async function testConnection(config) {
  const client = buildS3Client(config);
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return { ok: true };
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    const msg =
      status === 404 ? 'Bucket not found'
      : status === 403 ? 'Access denied — check credentials and bucket permissions'
      : err.message;
    return { ok: false, error: msg };
  }
}

// Async generator: yields one page (≤1000 objects) at a time.
// Caller processes each page immediately — only one page lives in memory at once.
export async function* streamListObjects(client, bucket, prefix) {
  let continuationToken;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    }));
    if (res.Contents?.length) yield res.Contents;
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
}

// Full load — used for the destination bucket where we need O(1) key lookup.
export async function listAllObjects(client, bucket, prefix) {
  const objects = [];
  for await (const page of streamListObjects(client, bucket, prefix)) {
    objects.push(...page);
  }
  return objects;
}

export async function deleteObject(client, bucket, key) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
