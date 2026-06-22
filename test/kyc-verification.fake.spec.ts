import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('FakeKycVerificationProvider', () => {
  it('cria sessão com providerRef, clientToken e expiresAt futuro; registra a chamada', async () => {
    const fake = new FakeKycVerificationProvider();
    const s = await fake.createSession('model:1');
    expect(s.providerRef).toBeTruthy();
    expect(s.clientToken).toBeTruthy();
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fake.calls).toEqual(['model:1']);
  });

  it('reset zera o histórico de chamadas', async () => {
    const fake = new FakeKycVerificationProvider();
    await fake.createSession('model:1');
    fake.reset();
    expect(fake.calls).toEqual([]);
  });
});
