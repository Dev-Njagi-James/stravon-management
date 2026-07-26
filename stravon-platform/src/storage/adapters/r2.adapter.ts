import { Injectable, OnModuleInit, ForbiddenException } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
      requestHandler: {
        requestTimeout: 5000,
      },
    });
  }

  /**
   * Generate a presigned upload URL for a file.
   * The key is constructed as: {projectId}/uploads/{filename}
   * This enforces prefix isolation: every file lives under the project's own prefix.
   */
  async getPresignedUploadUrl(
    projectId: string,
    filename: string,
    contentType: string,
    fileSize?: number,
  ): Promise<PresignedUploadResult> {
    const key = this.buildKey(projectId, filename);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      ...(fileSize !== undefined ? { ContentLength: fileSize } : {}),
    });

    const uploadUrl = await this.withTimeout(
      getSignedUrl(this.client!, command, { expiresIn: this.defaultExpiry }),
    );

    return {
      uploadUrl,
      publicUrl: `${this.publicUrlBase}/${key}`,
      key,
      filename,
    };
  }

  /**
   * Generate a presigned download URL for a file.
   */
  async getPresignedDownloadUrl(
    projectId: string,
    filename: string,
  ): Promise<PresignedDownloadResult> {
    const key = this.buildKey(projectId, filename);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const downloadUrl = await this.withTimeout(
      getSignedUrl(this.client!, command, { expiresIn: this.defaultExpiry }),
    );

    return {
      downloadUrl,
      publicUrl: `${this.publicUrlBase}/${key}`,
      key,
      filename,
    };
  }

  /**
   * Generate a presigned upload URL for replacing/renaming an existing file.
   * If renaming, the old file should be deleted separately.
   */
  async getPresignedReplaceUrl(
    projectId: string,
    filename: string,
    contentType: string,
    fileSize?: number,
  ): Promise<PresignedUploadResult> {
    // Same as upload — PUT on the new key overwrites
    return this.getPresignedUploadUrl(
      projectId,
      filename,
      contentType,
      fileSize,
    );
  }

  /**
   * Delete a file from R2.
   */
  async deleteFile(projectId: string, filename: string): Promise<void> {
    const key = this.buildKey(projectId, filename);

    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.withTimeout(this.client!.send(command));
  }

  /**
   * Get file metadata (head object).
   */
  async getFileInfo(
    projectId: string,
    filename: string,
  ): Promise<StorageFileInfo> {
    const key = this.buildKey(projectId, filename);

    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.withTimeout(this.client!.send(command));

    return {
      key,
      filename,
      projectId,
      contentType: response.ContentType ?? 'application/octet-stream',
      contentLength: response.ContentLength ?? 0,
    };
  }

  /**
   * Build the full R2 key with prefix isolation: {projectId}/uploads/{filename}
   * @throws Error if filename contains path traversal
   */
  private buildKey(projectId: string, filename: string): string {
    this.assertNoPathTraversal(filename);
    return `${projectId}/uploads/${filename}`;
  }

  /**
   * Reject filenames containing path traversal sequences.
   * This prevents a caller from escaping their own prefix.
   */
  private assertNoPathTraversal(filename: string): void {
    if (
      !filename ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      throw new Error(
        `Invalid filename: path traversal detected in "${filename}"`,
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
