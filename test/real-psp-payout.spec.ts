import { RealPspPayoutPort } from '../src/payout/real-psp-payout.adapter';

describe('RealPspPayoutPort', () => {
  it('lança "not configured" enquanto não houver provedor plugado', async () => {
    const psp = new RealPspPayoutPort();
    await expect(psp.sendPix('chave', '100', 'id-1')).rejects.toThrow(/not configured/i);
  });
});
