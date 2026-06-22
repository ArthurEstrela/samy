import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';
import { PresenceService } from './presence.service';
import { PresenceController } from './presence.controller';
import { FavoritesService } from './favorites.service';
import { FavoritesController } from './favorites.controller';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [ProfileController, PresenceController, FavoritesController],
  providers: [ProfileService, PresenceService, FavoritesService],
  exports: [ProfileService, PresenceService, FavoritesService],
})
export class MarketplaceModule {}
