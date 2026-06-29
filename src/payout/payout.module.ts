import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { KycModule } from '../kyc/kyc.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { PayoutService } from './payout.service';
import { PayoutProcessor } from './payout.processor';
import { PayoutController } from './payout.controller';
import { PSP_PAYOUT_PORT } from './psp-payout.port';
import { RealPspPayoutPort } from './real-psp-payout.adapter';

@Module({
  imports: [PrismaModule, LedgerModule, KycModule, AuthModule, UsersModule],
  controllers: [PayoutController],
  providers: [
    PayoutService,
    PayoutProcessor,
    { provide: PSP_PAYOUT_PORT, useClass: RealPspPayoutPort },
  ],
  exports: [PayoutService, PayoutProcessor],
})
export class PayoutModule {}
