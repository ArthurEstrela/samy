import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { TaximeterService } from './taximeter.service';

@Module({
  imports: [PrismaModule, BillingModule],
  providers: [TaximeterService],
  exports: [TaximeterService],
})
export class SchedulerModule {}
