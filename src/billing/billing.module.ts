import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { BillingService } from './billing.service';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule, UsersModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
