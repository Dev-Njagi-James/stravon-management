import { Module } from '@nestjs/common';
import { StorageController } from './storage.controller';
import { R2Adapter } from './adapters/r2.adapter';

@Module({
  controllers: [StorageController],
  providers: [R2Adapter],
  exports: [R2Adapter],
})
export class StorageModule {}
