import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { KycModule } from '../kyc/kyc.module';
import { PayoutService } from './payout.service';

@Module({
  imports: [LedgerModule, KycModule],
  providers: [PayoutService],
  exports: [PayoutService],
})
export class PayoutModule {}
