import { Injectable } from '@nestjs/common';
import type { PspPayoutPort } from './psp-payout.port';

@Injectable()
export class FakePspPayoutPort implements PspPayoutPort {
  public sent: Array<{ pixKey: string; amount: string; idempotencyKey: string }> = [];
  private shouldFail = false;

  failNext(): void {
    this.shouldFail = true;
  }

  reset(): void {
    this.sent = [];
    this.shouldFail = false;
  }

  async sendPix(
    pixKey: string,
    amount: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error('PSP payout failed');
    }
    this.sent.push({ pixKey, amount, idempotencyKey });
  }
}
