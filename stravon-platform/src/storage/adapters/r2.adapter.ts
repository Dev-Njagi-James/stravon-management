import { Injectable, OnModuleInit, ForbiddenException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

export interface StorageFileInfo {
  key: string;
  filename: string;
  projectId: string;
  contentType: string;
  contentLength: number;
}

export interface PresignedUploadResult {
  uploadUrl: string;
  publicUrl: string;
  key: string;
  uuid: string;
  filename: string;
}

export interface PresignedDownloadResult {
  downloadUrl: string;
  publicUrl: string;
  key: string;
  filename: string;
}

@Injectable()
export class R2Adapter implements OnModuleInit {
  private client: S3Client | null = null;
  private bucket: string = '';
  private publicUrlBase: string = '';
  private defaultExpiry = 3600; // 1 hour

  onModuleInit(): void {
    const accountId = process.env.R2_ACCOUNT_ID;
    const bucketName = process.env.R2_BUCKET_NAME;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

    if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be defined in environment variables',
      );
    }

    this.bucket = bucketName;
    this.publicUrlBase = `https://${bucketName}.${accountId}.r2.cloudflarestorage.com`;

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: {
        requestTimeout: 5000,
      },
    });
  }

  /**
   * Generate a presigned upload URL for a file.
   * The key is constructed as: {projectId}/uploads/{uuid}
   * This enforces prefix isolation: every file lives under the project's own prefix.
   * The original filename (if any) is stored as R2 object metadata, not in the key.
   */
  async getPresignedUploadUrl(
    projectId: string,
    filename: string,
    contentType: string,
    fileSize?: number,
  ): Promise<PresignedUploadResult> {
    const uuid = randomUUID();
    const key = this.buildKey(projectId, uuid);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: {
        originalFilename: filename,
      },
      ...(fileSize !== undefined ? { ContentLength: fileSize } : {}),
    });

    const uploadUrl = await this.withTimeout(
      getSignedUrl(this.client!, command, { expiresIn: this.defaultExpiry }),
    );

    return {
      uploadUrl,
      publicUrl: `https://cdn.stravontechlabs.com/${key}`,
      key,
      uuid,
      filename,
    };
  }

  /**
   * Generate a presigned download URL for a file given its full key.
   */
  async getPresignedDownloadUrl(key: string): Promise<PresignedDownloadResult> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const downloadUrl = await this.withTimeout(
      getSignedUrl(this.client!, command, { expiresIn: this.defaultExpiry }),
    );

    // Return the original human-readable filename from R2 metadata, falling
    // back to the object's UUID (last key segment) if the metadata is missing
    // or the HeadObject fails — same soft-fail pattern as modifyFile.
    const originalFilename = await this.getOriginalFilename(key);

    // The object's UUID is the last segment of the key: {projectId}/uploads/{uuid}
    const parts = key.split('/');
    const uuid = parts[parts.length - 1];

    return {
      downloadUrl,
      publicUrl: `${this.publicUrlBase}/${key}`,
      key,
      filename: originalFilename ?? uuid,
    };
  }

  /**
   * Generate a presigned upload URL for replacing an existing file.
   * Uses the provided key as-is — no new UUID generated for replace.
   */
  async getPresignedReplaceUrl(
    key: string,
    contentType: string,
    fileSize?: number,
  ): Promise<PresignedUploadResult> {
    // Fetch the object's original human-readable filename from R2 metadata
    // BEFORE the replace overwrites the object. The filename was stored as
    // metadata at createFile time and must be read now, because once the
    // client PUTs the new bytes to the presigned URL the metadata would
    // otherwise be lost.
    const originalFilename = await this.getOriginalFilename(key);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      // Preserve the original filename metadata on the replacing object so it
      // survives the overwrite and remains available to future replaces.
      ...(originalFilename ? { Metadata: { originalFilename } } : {}),
      ...(fileSize !== undefined ? { ContentLength: fileSize } : {}),
    });

    const uploadUrl = await this.withTimeout(
      getSignedUrl(this.client!, command, { expiresIn: this.defaultExpiry }),
    );

    // The R2 replace is confirmed at this point (presigned URL generated).
    // Purge the CDN edge cache for this object so the next read re-fetches
    // from origin instead of serving the stale, immutable cached copy.
    await this.purgeCacheUrl(key);

    // The object's UUID is the last segment of the key: {projectId}/uploads/{uuid}
    const parts = key.split('/');
    const uuid = parts[parts.length - 1];

    return {
      uploadUrl,
      publicUrl: `https://cdn.stravontechlabs.com/${key}`,
      key,
      uuid,
      filename: originalFilename ?? uuid,
    };
  }

  /**
   * Delete a file from R2 given its full key.
   */
  async deleteFile(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.withTimeout(this.client!.send(command));

    // The R2 delete succeeded. Purge the CDN edge cache for this object so a
    // deleted object is not served stale from the edge.
    await this.purgeCacheUrl(key);
  }

  /**
   * Purge a single URL from the Cloudflare CDN edge cache.
   *
   * This is a single-URL purge only — never a full-zone purge. It is called
   * after a successful modify/delete so the edge does not keep serving the
   * stale, immutable cached copy of an object that has changed or been removed.
   *
   * IMPORTANT: A purge failure is intentionally NOT retried and does NOT throw.
   * The underlying R2 operation has already succeeded and must not be rolled
   * back or reported as failed because of a cache-purge error. A failed purge
   * is a cache-staleness risk only, not a failed modify/delete — so we log it
   * and return normally. This is a deliberate choice, not a swallowed error.
   */
  private async purgeCacheUrl(key: string): Promise<void> {
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!zoneId || !apiToken) {
      console.error(
        `[r2] purgeCacheUrl: CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN must be set to purge cache for ${key}`,
      );
      return;
    }

    const url = `https://cdn.stravontechlabs.com/${key}`;

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: [url] }),
        },
      );

      if (!response.ok) {
        console.error(
          `[r2] purgeCacheUrl: Cloudflare purge failed for ${url}: ${response.status} ${response.statusText}`,
        );
      }
    } catch (err) {
      console.error(
        `[r2] purgeCacheUrl: Error purging ${url}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Fetch the human-readable original filename stored as R2 object metadata.
   * It was set as `originalFilename` at createFile time (and preserved on each
   * replace) and is read back as lowercased `originalfilename`. Returns
   * undefined if the object carries no such metadata (e.g. legacy objects not
   * created through this adapter) — no filename is fabricated.
   */
  private async getOriginalFilename(key: string): Promise<string | undefined> {
    try {
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.withTimeout(this.client!.send(headCommand));
      return response.Metadata?.['originalfilename'];
    } catch (err) {
      // A HeadObject failure must NOT block the modify operation — the
      // presigned URL still needs to be generated even if the original
      // filename can't be recovered. Log the failure and return undefined so
      // the caller falls back to the existing `filename: originalFilename ?? uuid`.
      console.error(
        `[r2] getOriginalFilename: HeadObject failed for ${key}:`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    }
  }

  /**
   * Get file metadata (head object) given its full key.
   */
  async getFileInfo(key: string): Promise<StorageFileInfo> {
    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.withTimeout(this.client!.send(command));

    // Extract filename (uuid) from the key: {projectId}/uploads/{uuid}
    const parts = key.split('/');
    const filename = parts[parts.length - 1];

    return {
      key,
      filename,
      projectId: parts[0],
      contentType: response.ContentType ?? 'application/octet-stream',
      contentLength: response.ContentLength ?? 0,
    };
  }

  /**
   * Build the full R2 key with prefix isolation: {projectId}/uploads/{segment}
   * @throws Error if segment contains path traversal
   */
  private buildKey(projectId: string, segment: string): string {
    this.assertNoPathTraversal(segment);
    return `${projectId}/uploads/${segment}`;
  }

  /**
   * Reject segments containing path traversal sequences.
   * This prevents a caller from escaping their own prefix.
   */
  private assertNoPathTraversal(segment: string): void {
    if (
      !segment ||
      segment.includes('..') ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      throw new Error(
        `Invalid segment: path traversal detected in "${segment}"`,
      );
    }
  }

  /**
   * Prefix-isolation validation: ensures a resolved key belongs to the given project.
   * Call this before any operation that receives a client-supplied key.
   */
  validateKeyOwnership(key: string, projectId: string): void {
    const expectedPrefix = `${projectId}/uploads/`;
    if (!key.startsWith(expectedPrefix)) {
      throw new ForbiddenException(
        `Access denied: key "${key}" does not belong to project "${projectId}"`,
      );
    }
  }

  /**
   * 5-second hard timeout — same pattern as ClerkAdapter.
   * No retries on timeout or failure. Returns the error immediately.
   */
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = 5000;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`R2 request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }
}
