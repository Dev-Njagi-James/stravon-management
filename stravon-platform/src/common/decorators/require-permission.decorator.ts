import { SetMetadata } from '@nestjs/common';

export const RequirePermission = (service: string, action: string) =>
  SetMetadata('permission', { service, action });
