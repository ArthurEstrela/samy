import { RealPspChargeAdapter } from '../src/wallet/real-psp-charge.adapter';
import { FakePspChargeAdapter } from '../src/wallet/fake-psp-charge.adapter';

describe('PSP charge adapters', () => {
  it('RealPspChargeAdapter lança "not configured" até plugar um provedor', async () => {
    const real = new RealPspChargeAdapter();
    await expect(
      real.createCharge({ rechargeId: 'r1', amount: '50.00', payerUserId: 'u1' }),
    ).rejects.toThrow(/not configured/i);
  });

  it('FakePspChargeAdapter devolve um QR determinístico com expiração futura', async () => {
    const fake = new FakePspChargeAdapter();
    const out = await fake.createCharge({ rechargeId: 'r1', amount: '50.00', payerUserId: 'u1' });
    expect(out.pspChargeId).toContain('r1');
    expect(typeof out.qrText).toBe('string');
    expect(out.qrText.length).toBeGreaterThan(0);
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
