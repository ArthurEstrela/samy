import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { KycModule } from '../kyc/kyc.module';
import { PayoutService } from './payout.service';
import { PayoutProcessor } from './payout.processor';
import { PSP_PAYOUT_PORT } from './psp-payout.port';
import { FakePspPayoutPort } from './fake-psp-payout.adapter';

@Module({
  imports: [LedgerModule, KycModule],
  providers: [
    PayoutService,
    PayoutProcessor,
    { provide: PSP_PAYOUT_PORT, useClass: FakePspPayoutPort },
  ],
  exports: [PayoutService, PayoutProcessor],
})
export class PayoutModule {}
