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
import { KycVerificationModule } from './kyc-verification/kyc-verification.module';
import { RedisModule } from './redis/redis.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { CallsModule } from './calls/calls.module';
import { BillingModule } from './billing/billing.module';
import { HealthModule } from './health/health.module';

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
    KycVerificationModule,
    RedisModule,
    MarketplaceModule,
    CallsModule,
    BillingModule,
    HealthModule,
  ],
})
export class AppModule {}
