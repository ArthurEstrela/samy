import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletModule } from '../src/wallet/wallet.module';
import { WalletService } from '../src/wallet/wallet.service';

describe('WalletService.expireStaleRecharges', () => {
  let wallet: WalletService; let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, WalletModule] }).compile();
    wallet = mod.get(WalletService); prisma = mod.get(PrismaService);
  });
  beforeEach(async () => { await prisma.recharge.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  async function rc(status: string, expiresAt: Date | null): Promise<string> {
    const u = await prisma.user.create({ data: { role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'x@y.com', displayName: 'X', status: 'ACTIVE' } });
    const r = await prisma.recharge.create({ data: { userId: u.id, amount: new Prisma.Decimal('10.00'), status, expiresAt } });
    return r.id;
  }

  it('expira PENDING vencida; preserva não-vencida e PAID', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const venc = await rc('PENDING', past);
    const naoVenc = await rc('PENDING', future);
    const paga = await rc('PAID', past);

    const n = await wallet.expireStaleRecharges();
    expect(n).toBe(1);
    expect((await prisma.recharge.findUnique({ where: { id: venc } }))?.status).toBe('EXPIRED');
    expect((await prisma.recharge.findUnique({ where: { id: naoVenc } }))?.status).toBe('PENDING');
    expect((await prisma.recharge.findUnique({ where: { id: paga } }))?.status).toBe('PAID');
  });

  it('sem vencidas → 0', async () => {
    await rc('PENDING', new Date(Date.now() + 60_000));
    expect(await wallet.expireStaleRecharges()).toBe(0);
  });
});
