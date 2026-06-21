import { createHmac } from 'crypto';
import { PspSignatureValidator } from '../src/wallet/psp-signature.validator';

describe('PspSignatureValidator', () => {
  const secret = 'test-webhook-secret';
  const validator = new PspSignatureValidator(secret);

  it('aceita assinatura HMAC válida', () => {
    const body = Buffer.from(JSON.stringify({ event: 'payment.confirmed' }));
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(validator.isValid(body, sig)).toBe(true);
  });

  it('rejeita assinatura inválida', () => {
    const body = Buffer.from('{}');
    expect(validator.isValid(body, 'deadbeef')).toBe(false);
  });
});
