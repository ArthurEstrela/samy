import { Injectable } from '@nestjs/common';
import type { PspChargePort, PspChargeInput, PspCharge } from './psp-charge.port';

@Injectable()
export class FakePspChargeAdapter implements PspChargePort {
  async createCharge(input: PspChargeInput): Promise<PspCharge> {
    return {
      pspChargeId: `fake-charge:${input.rechargeId}`,
      qrText: `00020126FAKE-PIX-${input.rechargeId}-${input.amount}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }
}
