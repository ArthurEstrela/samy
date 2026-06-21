import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { PspSignatureValidator } from './psp-signature.validator';

@Module({
  imports: [LedgerModule],
  controllers: [WalletController],
  providers: [
    WalletService,
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
