import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class WalletService {
  constructor(private readonly ledger: LedgerService) {}

  async creditRecharge(
    pspPaymentId: string,
    account: string,
    amount: Prisma.Decimal,
  ): Promise<{ posted: boolean }> {
    if (!amount.greaterThan(new Prisma.Decimal(0))) {
      throw new BadRequestException('amount must be positive');
    }
    return this.ledger.postTransaction(`recharge:${pspPaymentId}`, [
      { account, entryType: 'RECARGA', amount },
      { account: 'source:external', entryType: 'RECARGA_OFFSET', amount: amount.negated() },
    ]);
  }
}
