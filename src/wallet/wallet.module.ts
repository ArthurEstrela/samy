import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { RechargeController } from './recharge.controller';
import { WalletBalanceController } from './wallet-balance.controller';
import { PspSignatureValidator } from './psp-signature.validator';
import { PSP_CHARGE_PORT } from './psp-charge.port';
import { RealPspChargeAdapter } from './real-psp-charge.adapter';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule, UsersModule],
  controllers: [WalletController, RechargeController, WalletBalanceController],
  providers: [
    WalletService,
    { provide: PSP_CHARGE_PORT, useClass: RealPspChargeAdapter },
    {
      provide: PspSignatureValidator,
      useFactory: (): PspSignatureValidator => {
        const secret = process.env.PSP_WEBHOOK_SECRET;
        if (!secret) {
          throw new Error('PSP_WEBHOOK_SECRET env var is required');
        }
        return new PspSignatureValidator(secret);
      },
    },
  ],
  exports: [WalletService],
})
export class WalletModule {}
