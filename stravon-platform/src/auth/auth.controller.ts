import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  NotFoundException,
  InternalServerErrorException,
  Req,
} from '@nestjs/common';
import { ClerkAdapter } from './adapters/clerk.adapter';
import { SupabaseService } from '../common/supabase/supabase.service';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import type { AuthenticatedRequest } from '../common/guards/api-key.guard';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly clerkAdapter: ClerkAdapter,
    private readonly supabaseService: SupabaseService,
  ) {}

  @Get('users/:id')
  @RequirePermission('auth', 'read')
  async getUser(@Param('id') userId: string, @Req() req: AuthenticatedRequest) {
    await this.verifyOwnership(req.project_id, userId);

    const user = await this.clerkAdapter.getUser(userId);
    return user;
  }

  @Post('users')
  @RequirePermission('auth', 'create')
  async createUser(
    @Body()
    body: {
      email: string;
      firstName?: string;
      lastName?: string;
      password?: string;
    },
    @Req() req: AuthenticatedRequest,
  ) {
    const user = await this.clerkAdapter.createUser(body);

    const { error: insertError } = await this.supabaseService.client
      .from('project_users')
      .insert({
        project_id: req.project_id,
        clerk_user_id: user.id,
      });

    if (insertError) {
      // Rollback Clerk user creation
      await this.clerkAdapter.deleteUser(user.id).catch(() => {});
      throw new InternalServerErrorException('Failed to link user to project');
    }

    return user;
  }

  @Patch('users/:id')
  @RequirePermission('auth', 'modify')
  async updateUser(
    @Param('id') userId: string,
    @Body()
    body: {
      firstName?: string;
      lastName?: string;
      password?: string;
    },
    @Req() req: AuthenticatedRequest,
  ) {
    await this.verifyOwnership(req.project_id, userId);

    const user = await this.clerkAdapter.updateUser(userId, body);
    return user;
  }

  @Delete('users/:id')
  @RequirePermission('auth', 'delete')
  async deleteUser(
    @Param('id') userId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.verifyOwnership(req.project_id, userId);

    await this.clerkAdapter.deleteUser(userId);

    // Remove the project_users link
    await this.supabaseService.client
      .from('project_users')
      .delete()
      .eq('project_id', req.project_id)
      .eq('clerk_user_id', userId);

    return { deleted: true };
  }

  private async verifyOwnership(
    projectId: string,
    clerkUserId: string,
  ): Promise<void> {
    const { data, error } = await this.supabaseService.client
      .from('project_users')
      .select('id')
      .eq('project_id', projectId)
      .eq('clerk_user_id', clerkUserId)
      .single();

    if (error || !data) {
      throw new NotFoundException('User not found');
    }
  }
}
