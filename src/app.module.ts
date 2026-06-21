import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [PrismaModule, LedgerModule, WalletModule],
})
export class AppModule {}
