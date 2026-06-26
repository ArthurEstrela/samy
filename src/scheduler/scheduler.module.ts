import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { PayoutModule } from '../payout/payout.module';
import { TaximeterService } from './taximeter.service';
import { PayoutScheduler } from './payout.scheduler';

@Module({
  imports: [PrismaModule, BillingModule, PayoutModule],
  providers: [TaximeterService, PayoutScheduler],
  exports: [TaximeterService, PayoutScheduler],
})
export class SchedulerModule {}
