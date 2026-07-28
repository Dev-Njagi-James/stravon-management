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
} from '@nestjs/common';

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
  constructor(private readonly r2Adapter: R2Adapter) {}

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
    request.storage_metadata = {
      bytes: body.fileSize,
      bytes_direction: 'upload',
    };
    return this.r2Adapter.getPresignedUploadUrl(
      request.project_id,
      body.filename,
      body.contentType,
      body.fileSize,
    );
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
}
