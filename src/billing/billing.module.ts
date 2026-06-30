import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { RankingModule } from '../ranking/ranking.module';
import { BillingService } from './billing.service';
import { GiftsController } from './gifts.controller';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule, UsersModule, RankingModule],
  controllers: [GiftsController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
