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
      useFactory: (): PspSignatureValidator =>
        new PspSignatureValidator(process.env.PSP_WEBHOOK_SECRET ?? ''),
    },
  ],
  exports: [WalletService],
})
export class WalletModule {}
