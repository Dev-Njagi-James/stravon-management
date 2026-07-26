import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseModule } from './common/supabase/supabase.module';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { CallLoggingInterceptor } from './common/interceptors/call-logging.interceptor';
import { AuthModule } from './auth/auth.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [SupabaseModule, AuthModule, StorageModule],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CallLoggingInterceptor,
    },
  ],
})
export class AppModule {}
