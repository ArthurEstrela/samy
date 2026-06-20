import { Prisma } from '@prisma/client';

export interface LedgerEntryInput {
  account: string;
  entryType: string;
  amount: Prisma.Decimal;
  metadata?: Prisma.InputJsonValue;
}
