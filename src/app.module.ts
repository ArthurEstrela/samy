import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';

@Module({
  imports: [PrismaModule, LedgerModule],
})
export class AppModule {}
