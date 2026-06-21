import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { WalletModule } from './wallet/wallet.module';
import { KycModule } from './kyc/kyc.module';
import { PayoutModule } from './payout/payout.module';
import { IdentityModule } from './identity/identity.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    PrismaModule,
    LedgerModule,
    WalletModule,
    KycModule,
    PayoutModule,
    IdentityModule,
    UsersModule,
    AuthModule,
    AdminModule,
  ],
})
export class AppModule {}
