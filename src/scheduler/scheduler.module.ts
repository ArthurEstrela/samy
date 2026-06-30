import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { PayoutModule } from '../payout/payout.module';
import { WalletModule } from '../wallet/wallet.module';
import { TaximeterService } from './taximeter.service';
import { PayoutScheduler } from './payout.scheduler';
import { RechargeSweeper } from './recharge.sweeper';

@Module({
  imports: [PrismaModule, BillingModule, PayoutModule, WalletModule],
  providers: [TaximeterService, PayoutScheduler, RechargeSweeper],
  exports: [TaximeterService, PayoutScheduler, RechargeSweeper],
})
export class SchedulerModule {}
