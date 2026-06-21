import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export const PSP_WEBHOOK_SECRET = 'PSP_WEBHOOK_SECRET';

@Injectable()
export class PspSignatureValidator {
  constructor(private readonly secret: string) {}

  isValid(rawBody: Buffer, signature: string): boolean {
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}
