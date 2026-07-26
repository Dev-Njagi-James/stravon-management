import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { ClerkAdapter } from './adapters/clerk.adapter';

@Module({
  controllers: [AuthController],
  providers: [ClerkAdapter],
  exports: [ClerkAdapter],
})
export class AuthModule {}
