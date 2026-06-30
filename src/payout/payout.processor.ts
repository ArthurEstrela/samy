import { Inject, Injectable } from '@nestjs/common';
import { Payout } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PSP_PAYOUT_PORT } from './psp-payout.port';
import type { PspPayoutPort } from './psp-payout.port';

const DEFAULT_STUCK_MS = 120_000;

@Injectable()
export class PayoutProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(PSP_PAYOUT_PORT) private readonly psp: PspPayoutPort,
  ) {}

  async processPending(): Promise<void> {
    const pending = await this.prisma.payout.findMany({ where: { status: 'PENDING' } });
    for (const payout of pending) {
      // Reivindica atomicamente antes de enviar (evita dois workers enviarem o mesmo).
      const claimed = await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'PROCESSING', processingAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      await this.settle(payout);
    }
  }

  async recoverStuck(stuckMs: number = stuckMsFromEnv()): Promise<void> {
    const cutoff = new Date(Date.now() - stuckMs);
    const stuck = await this.prisma.payout.findMany({
      where: { status: 'PROCESSING', OR: [{ processingAt: { lt: cutoff } }, { processingAt: null }] },
    });
    for (const payout of stuck) {
      // Re-reivindica (renova o carimbo) — se outro worker já pegou, count !== 1.
      const claimed = await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'PROCESSING' },
        data: { processingAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      await this.settle(payout);
    }
  }

  // Envia o PIX (idempotente por payout.id) e finaliza; no erro, estorna e marca FAILED.
  private async settle(payout: Payout): Promise<void> {
    try {
      await this.psp.sendPix(payout.pixKey, payout.amount.toString(), payout.id);
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
        await tx.payout.update({ where: { id: payout.id }, data: { status: 'FAILED', processedAt: new Date() } });
      });
    }
  }
}

function stuckMsFromEnv(): number {
  const raw = Number(process.env.PAYOUT_STUCK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STUCK_MS;
}
