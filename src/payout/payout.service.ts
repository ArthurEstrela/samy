import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Payout, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { KYC_PORT } from '../kyc/kyc.port';
import type { KycPort } from '../kyc/kyc.port';

@Injectable()
export class PayoutService {
  private readonly minPayout: Prisma.Decimal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(KYC_PORT) private readonly kyc: KycPort,
  ) {
    this.minPayout = new Prisma.Decimal(process.env.MIN_PAYOUT ?? '200.00');
  }

  async requestPayout(
    account: string,
    amount: Prisma.Decimal,
    pixKey: string,
  ): Promise<Payout> {
    if (!(await this.kyc.isApproved(account))) {
      throw new ForbiddenException('KYC not approved');
    }
    if (amount.lessThan(this.minPayout)) {
      throw new BadRequestException('Amount below minimum payout');
    }

    return this.prisma.$transaction(async (tx) => {
      // Per-account, transaction-scoped advisory lock: concurrent payouts for
      // the same account serialize here, closing the read-balance/write-debit
      // TOCTOU window. hashtext returns int4 -> pg_advisory_xact_lock(bigint).
      // Auto-releases at transaction end.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${account}))`;
      const balance = await this.ledger.getBalance(account, tx);
      if (balance.lessThan(amount)) {
        throw new BadRequestException('Insufficient balance');
      }
      const payout = await tx.payout.create({
        data: { account, amount, status: 'PENDING', pixKey },
      });
      await this.ledger.postTransaction(
        `payout:${payout.id}`,
        [
          { account, entryType: 'SAQUE', amount: amount.negated() },
          { account: 'source:external', entryType: 'SAQUE_OFFSET', amount },
        ],
        tx,
      );
      return payout;
    });
  }

  async listForAccount(account: string): Promise<import('@prisma/client').Payout[]> {
    return this.prisma.payout.findMany({ where: { account }, orderBy: { createdAt: 'desc' } });
  }

  async grantDevEarnings(account: string): Promise<void> {
    await this.ledger.postTransaction(`dev-earn:${account}:${Date.now()}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('300.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-300.00') },
    ]);
    await this.prisma.kycStatus.upsert({ where: { account }, update: { approved: true }, create: { account, approved: true } });
  }
}
