import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KYC_PORT } from './kyc.port';
import { TableKycAdapter } from './table-kyc.adapter';

@Module({
  imports: [PrismaModule],
  providers: [{ provide: KYC_PORT, useClass: TableKycAdapter }],
  exports: [KYC_PORT],
})
export class KycModule {}
