import { createHmac } from 'crypto';
import { KycSignatureValidator } from '../src/kyc-verification/kyc-signature.validator';

describe('KycSignatureValidator', () => {
  const secret = 'test-kyc-webhook-secret';
  const validator = new KycSignatureValidator(secret);

  it('aceita assinatura HMAC válida', () => {
    const body = Buffer.from(JSON.stringify({ outcome: 'APPROVED' }));
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(validator.isValid(body, sig)).toBe(true);
  });

  it('rejeita assinatura inválida', () => {
    expect(validator.isValid(Buffer.from('{}'), 'deadbeef')).toBe(false);
  });
});
