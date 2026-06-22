import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';
import { PresenceService } from './presence.service';
import { PresenceController } from './presence.controller';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [ProfileController, PresenceController],
  providers: [ProfileService, PresenceService],
  exports: [ProfileService, PresenceService],
})
export class MarketplaceModule {}
