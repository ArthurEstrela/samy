import { Injectable } from '@nestjs/common';
import type { PspPayoutPort } from './psp-payout.port';

// Ponto-de-plugar do PSP de saque (cash-out PIX). Enquanto não houver provedor
// (Suitpay/Pushin/etc.) configurado, lança erro claro — NUNCA finge pagar.
@Injectable()
export class RealPspPayoutPort implements PspPayoutPort {
  async sendPix(_pixKey: string, _amount: string, _idempotencyKey: string): Promise<void> {
    throw new Error('PSP payout not configured');
  }
}
