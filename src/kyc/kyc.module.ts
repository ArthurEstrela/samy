import { Module } from '@nestjs/common';
import { KYC_PORT } from './kyc.port';
import { TableKycAdapter } from './table-kyc.adapter';

@Module({
  providers: [{ provide: KYC_PORT, useClass: TableKycAdapter }],
  exports: [KYC_PORT],
})
export class KycModule {}
