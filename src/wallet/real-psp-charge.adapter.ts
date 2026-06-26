import { Injectable } from '@nestjs/common';
import type { PspChargePort, PspChargeInput, PspCharge } from './psp-charge.port';

// Ponto-de-plugar do PSP de cobrança (cash-in PIX). Enquanto não houver provedor
// configurado, lança erro claro — nunca finge criar cobrança.
@Injectable()
export class RealPspChargeAdapter implements PspChargePort {
  async createCharge(_input: PspChargeInput): Promise<PspCharge> {
    throw new Error('PSP charge not configured');
  }
}
