import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Query,
  Body,
  Req,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';
import { R2Adapter } from './adapters/r2.adapter';
import type {
  PresignedUploadResult,
  PresignedDownloadResult,
  StorageFileInfo,
} from './adapters/r2.adapter';
import type { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { RequirePermission } from '../common/decorators/require-permission.decorator';

export const PERMISSION_KEY = 'permission';

@Controller('v1/storage')
export class StorageController {
  constructor(
    private readonly r2Adapter: R2Adapter,
    private readonly supabaseService: SupabaseService,
  ) {}

  /**
   * POST /v1/storage/files
   * Generate a presigned upload URL.
   * Client then PUTs the file bytes directly to the returned uploadUrl.
   */
  @Post('files')
  @RequirePermission('storage', 'create')
  async createFile(
    @Req() request: AuthenticatedRequest,
    @Body() body: { filename: string; contentType: string; fileSize?: number },
  ): Promise<PresignedUploadResult> {
    const result = await this.r2Adapter.getPresignedUploadUrl(
      request.project_id,
      body.filename,
      body.contentType,
      body.fileSize,
    );
    request.storage_metadata = {
      bytes: body.fileSize,
      bytes_direction: 'upload',
      key: result.key,
    };
    return result;
  }

  /**
   * GET /v1/storage/files?key=...
   * Generate a presigned download URL.
   * Client then GETs the file bytes directly from the returned downloadUrl.
   */
  @Get('files')
  @RequirePermission('storage', 'read')
  async readFile(
    @Req() request: AuthenticatedRequest,
    @Query('key') key: string,
  ): Promise<PresignedDownloadResult> {
    if (!key) {
      throw new BadRequestException('key query parameter is required');
    }
    this.r2Adapter.validateKeyOwnership(key, request.project_id);
    const result = await this.r2Adapter.getPresignedDownloadUrl(key);
    request.storage_metadata = {
      bytes_direction: 'download',
      key,
    };
    return result;
  }

  /**
   * PATCH /v1/storage/files?key=...
   * Generate a presigned URL to replace/overwrite an existing file.
   * Client then PUTs the new file bytes directly to the returned uploadUrl.
   */
  @Patch('files')
  @RequirePermission('storage', 'modify')
  async modifyFile(
    @Req() request: AuthenticatedRequest,
    @Query('key') key: string,
    @Body() body: { contentType: string; fileSize?: number },
  ): Promise<PresignedUploadResult> {
    if (!key) {
      throw new BadRequestException('key query parameter is required');
    }
    this.r2Adapter.validateKeyOwnership(key, request.project_id);
    request.storage_metadata = {
      bytes: body.fileSize,
      bytes_direction: 'upload',
      key,
    };
    return this.r2Adapter.getPresignedReplaceUrl(
      key,
      body.contentType,
      body.fileSize,
    );
  }

  /**
   * DELETE /v1/storage/files?key=...
   * Delete a file from R2.
   */
  @Delete('files')
  @RequirePermission('storage', 'delete')
  async deleteFile(
    @Req() request: AuthenticatedRequest,
    @Query('key') key: string,
  ): Promise<{ success: boolean; key: string }> {
    if (!key) {
      throw new BadRequestException('key query parameter is required');
    }
    this.r2Adapter.validateKeyOwnership(key, request.project_id);
    await this.r2Adapter.deleteFile(key);
    request.storage_metadata = { key, bytes_direction: 'delete' };
    return { success: true, key };
  }

  /**
   * GET /v1/storage/files/info?key=...
   * Get file metadata (head object).
   */
  @Get('files/info')
  @RequirePermission('storage', 'read')
  async getFileInfo(
    @Req() request: AuthenticatedRequest,
    @Query('key') key: string,
  ): Promise<StorageFileInfo> {
    if (!key) {
      throw new BadRequestException('key query parameter is required');
    }
    this.r2Adapter.validateKeyOwnership(key, request.project_id);
    const info = await this.r2Adapter.getFileInfo(key);
    request.storage_metadata = {
      bytes: info.contentLength,
      bytes_direction: 'download',
    };
    return info;
  }

  /**
   * POST /v1/storage/files/complete
   * Confirm an upload has completed and update the original call_logs
   * row from the corresponding POST /v1/storage/files request with the
   * real, verified byte count from R2 (HeadObject).
   *
   * This route does NOT create a second call_logs row for the same upload.
   * CallLoggingInterceptor is configured to skip insertion when
   * request.skip_call_logging is set.
   */
  @Post('files/complete')
  @RequirePermission('storage', 'create')
  async completeUpload(
    @Req() request: AuthenticatedRequest,
    @Body() body: { key: string },
  ): Promise<{ verified: boolean; bytes: number }> {
    if (!body.key) {
      throw new BadRequestException('key is required in request body');
    }
    this.r2Adapter.validateKeyOwnership(body.key, request.project_id);

    // Update the matching storage call_logs row for this upload. This covers
    // rows originated by both 'create' (POST) and 'modify' (PATCH) actions,
    // which are linked the same way by project_id + storage_key. The query is
    // narrowed to those actions and ordered by created_at desc with limit 1 so
    // it can't match a read/delete row on the same key and won't throw on
    // multiple qualifying rows.
    const { data: latestLogs, error: findError } =
      await this.supabaseService.client
        .from('call_logs')
        .select('log_id, bytes, completed_at')
        .eq('project_id', request.project_id)
        .eq('service', 'storage')
        .in('action', ['create', 'modify'])
        .eq('status', 'success')
        .eq('storage_key', body.key)
        .order('created_at', { ascending: false })
        .limit(1);

    const latestLog:
      | {
          log_id: string;
          bytes: number | null;
          completed_at: string | null;
        }
      | undefined = latestLogs?.[0];

    if (findError || !latestLog) {
      throw new NotFoundException(
        `No matching call_logs create/modify row found for project_id ${request.project_id} and storage_key ${body.key}`,
      );
    }

    // Idempotency: if this row was already completed, return the stored bytes
    // without re-running the R2 HeadObject or re-updating the row.
    if (latestLog.completed_at) {
      request.skip_call_logging = true;
      return { verified: true, bytes: latestLog.bytes ?? 0 };
    }

    let contentLength: number;
    try {
      const info = await this.r2Adapter.getFileInfo(body.key);
      contentLength = info.contentLength;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'R2 HeadObject failed';
      throw new NotFoundException(
        `Upload not found or not yet complete: ${message}`,
      );
    }

    const { error: updateError } = await this.supabaseService.client
      .from('call_logs')
      .update({ bytes: contentLength, completed_at: new Date().toISOString() })
      .eq('log_id', latestLog.log_id);

    if (updateError) {
      // The client already has confirmation the upload succeeded. A
      // metering-side write failure should not surface as an error to the
      // client, but it must be visible server-side.
      console.error(
        `[storage/complete] Failed to update call_logs row ${latestLog.log_id} with verified byte count:`,
        updateError,
      );
    }

    // Prevent CallLoggingInterceptor from writing a second row for this
    // completion request — the upload is already represented by the
    // updated row above.
    request.skip_call_logging = true;

    return { verified: true, bytes: contentLength };
  }
}
