import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { WalletModule } from './wallet/wallet.module';
import { KycModule } from './kyc/kyc.module';
import { PayoutModule } from './payout/payout.module';

@Module({
  imports: [PrismaModule, LedgerModule, WalletModule, KycModule, PayoutModule],
})
export class AppModule {}
