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
      await this.prisma.recharge.update({ where: { id: recharge.id }, data: { status: 'FAILED' } });
      throw new ServiceUnavailableException('payment provider unavailable');
    }
  }
}
