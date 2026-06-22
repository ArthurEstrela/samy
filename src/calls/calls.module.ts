import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { CallService } from './call.service';
import { CallController } from './call.controller';
import { MEDIA_SERVER } from './media-server.port';
import { LivekitMediaServer } from './livekit-media-server.adapter';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule, UsersModule],
  controllers: [CallController],
  providers: [CallService, { provide: MEDIA_SERVER, useClass: LivekitMediaServer }],
  exports: [CallService],
})
export class CallsModule {}
