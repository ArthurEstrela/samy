import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PSP_PAYOUT_PORT } from './psp-payout.port';
import type { PspPayoutPort } from './psp-payout.port';

@Injectable()
export class PayoutProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(PSP_PAYOUT_PORT) private readonly psp: PspPayoutPort,
  ) {}

  async processPending(): Promise<void> {
    const pending = await this.prisma.payout.findMany({
      where: { status: 'PENDING' },
    });

    for (const payout of pending) {
      // Atomically claim the payout before sending. If another worker already
      // claimed it (claimed.count === 0), skip — avoids double-send.
      // TODO: a later story should recover stuck-PROCESSING payouts.
      const claimed = await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'PROCESSING' },
      });
      if (claimed.count !== 1) {
        continue;
      }

      try {
        await this.psp.sendPix(
          payout.pixKey,
          payout.amount.toString(),
          payout.id,
        );
        await this.prisma.payout.update({
          where: { id: payout.id },
          data: { status: 'PAID', processedAt: new Date() },
        });
      } catch {
        await this.prisma.$transaction(async (tx) => {
          await this.ledger.postTransaction(
            `payout-reversal:${payout.id}`,
            [
              { account: payout.account, entryType: 'SAQUE_ESTORNO', amount: payout.amount },
              { account: 'source:external', entryType: 'SAQUE_ESTORNO_OFFSET', amount: payout.amount.negated() },
            ],
            tx,
          );
          await tx.payout.update({
            where: { id: payout.id },
            data: { status: 'FAILED', processedAt: new Date() },
          });
        });
      }
    }
  }
}
