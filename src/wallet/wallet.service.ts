import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PSP_CHARGE_PORT } from './psp-charge.port';
import type { PspChargePort } from './psp-charge.port';

@Injectable()
export class WalletService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
    @Inject(PSP_CHARGE_PORT) private readonly pspCharge: PspChargePort,
  ) {}

  async confirmRecharge(
    pspChargeId: string,
    eventAmount: Prisma.Decimal,
  ): Promise<{ credited: boolean; reason?: 'unknown' | 'already' | 'amount_mismatch' }> {
    return this.prisma.$transaction(async (tx) => {
      const recharge = await tx.recharge.findFirst({ where: { pspChargeId } });
      if (!recharge) {
        return { credited: false, reason: 'unknown' as const };
      }
      if (recharge.status === 'PAID') {
        return { credited: false, reason: 'already' as const };
      }
      if (!eventAmount.equals(recharge.amount)) {
        return { credited: false, reason: 'amount_mismatch' as const };
      }
      const claimed = await tx.recharge.updateMany({
        where: { id: recharge.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date() },
      });
      if (claimed.count !== 1) {
        return { credited: false, reason: 'already' as const };
      }
      await this.ledger.postTransaction(
        `recharge:${recharge.id}`,
        [
          { account: `client:${recharge.userId}`, entryType: 'RECARGA', amount: recharge.amount },
          { account: 'source:external', entryType: 'RECARGA_OFFSET', amount: recharge.amount.negated() },
        ],
        tx,
      );
      return { credited: true };
    });
  }

  async createRecharge(
    userId: string,
    amount: Prisma.Decimal,
  ): Promise<{ id: string; amount: string; status: string; qrText: string | null; expiresAt: Date | null }> {
    const min = new Prisma.Decimal(process.env.MIN_RECHARGE ?? '5.00');
    if (amount.decimalPlaces() > 2 || !amount.greaterThanOrEqualTo(min)) {
      throw new BadRequestException(`amount must be a positive value of at least ${min.toString()}`);
    }
    const recharge = await this.prisma.recharge.create({
      data: { userId, amount, status: 'PENDING' },
    });
    try {
      const charge = await this.pspCharge.createCharge({
        rechargeId: recharge.id,
        amount: amount.toString(),
        payerUserId: userId,
      });
      const updated = await this.prisma.recharge.update({
        where: { id: recharge.id },
        data: { pspChargeId: charge.pspChargeId, qrText: charge.qrText, expiresAt: charge.expiresAt },
      });
      return {
        id: updated.id,
        amount: updated.amount.toString(),
        status: updated.status,
        qrText: updated.qrText,
        expiresAt: updated.expiresAt,
      };
    } catch {
      // NOTE: se a chamada ao PSP teve sucesso mas este update falhar, a recarga fica
      // FAILED sem pspChargeId. Um payment.confirmed posterior do PSP cairá como órfão
      // (não creditado). Resolver ao plugar um provedor real (fluxo de retry/recuperação).
      await this.prisma.recharge.update({ where: { id: recharge.id }, data: { status: 'FAILED' } });
      throw new ServiceUnavailableException('payment provider unavailable');
    }
  }
}
