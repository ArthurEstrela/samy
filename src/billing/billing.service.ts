import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { resolveTakeRate, computeSplit } from './take-rate';

export interface ChargeResult {
  charged: boolean;
  alreadyCharged?: boolean;
  ended?: boolean;
  reason?: string;
}

@Injectable()
export class BillingService {
  private readonly globalTakeRate: Prisma.Decimal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {
    const raw = process.env.GLOBAL_TAKE_RATE;
    if (!raw) {
      throw new Error('GLOBAL_TAKE_RATE env var is required');
    }
    this.globalTakeRate = new Prisma.Decimal(raw);
  }

  async chargeMinute(callId: string, minuteNumber: number): Promise<ChargeResult> {
    return this.prisma.$transaction(async (tx) => {
      const call = await tx.call.findUnique({ where: { id: callId } });
      if (!call) {
        return { charged: false, reason: 'not_found' };
      }
      await this.lock(tx, `call-client:${call.clientUserId}`);

      // Re-read under the lock so the status is authoritative (a concurrent
      // hangup/end between the pre-lock read and the lock won't be charged).
      const fresh = await tx.call.findUnique({ where: { id: callId } });
      if (!fresh) {
        return { charged: false, reason: 'not_found' };
      }

      const group = `call:${callId}:min:${minuteNumber}`;
      const existing = await tx.ledgerEntry.findFirst({ where: { transactionGroup: group } });
      if (existing) {
        return { charged: false, alreadyCharged: true };
      }
      if (fresh.status !== 'ACTIVE') {
        return { charged: false, reason: 'not_active' };
      }

      const price = fresh.pricePerMinuteSnapshot;
      const balance = await this.ledger.getBalance(`client:${fresh.clientUserId}`, tx);
      if (balance.lessThan(price)) {
        await tx.call.updateMany({
          where: { id: callId, status: 'ACTIVE' },
          data: { status: 'ENDED', endReason: 'NO_CREDITS', endedAt: new Date() },
        });
        return { charged: false, ended: true };
      }

      const profile = await tx.modelProfile.findUnique({ where: { userId: fresh.modelUserId } });
      const takeRate = resolveTakeRate(profile?.takeRate ?? null, this.globalTakeRate);
      const { commission, modelShare } = computeSplit(price, takeRate);
      await this.ledger.postTransaction(
        group,
        [
          { account: `client:${fresh.clientUserId}`, entryType: 'CONSUMO_MIN', amount: price.negated() },
          { account: `model:${fresh.modelUserId}`, entryType: 'GANHO_MIN', amount: modelShare },
          { account: 'platform', entryType: 'COMISSAO', amount: commission },
        ],
        tx,
      );
      return { charged: true };
    });
  }

  private async lock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
}
