import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycModule } from '../src/kyc/kyc.module';
import { PayoutModule } from '../src/payout/payout.module';
import { PayoutProcessor } from '../src/payout/payout.processor';
import { PSP_PAYOUT_PORT } from '../src/payout/psp-payout.port';
import { FakePspPayoutPort } from '../src/payout/fake-psp-payout.adapter';

describe('PayoutProcessor.recoverStuck', () => {
  let processor: PayoutProcessor; let prisma: PrismaService; let ledger: LedgerService; let psp: FakePspPayoutPort;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, LedgerModule, KycModule, PayoutModule] })
      .overrideProvider(PSP_PAYOUT_PORT).useClass(FakePspPayoutPort).compile();
    processor = mod.get(PayoutProcessor); prisma = mod.get(PrismaService); ledger = mod.get(LedgerService); psp = mod.get(PSP_PAYOUT_PORT);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany(); await prisma.payout.deleteMany(); psp.reset();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function stuck(account: string, processingAt: Date | null): Promise<string> {
    const p = await prisma.payout.create({ data: { account, amount: new Prisma.Decimal('100.00'), status: 'PROCESSING', pixKey: 'k', processingAt } });
    return p.id;
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('reprocessa PROCESSING parado (processingAt antigo) → PAID', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const id = await stuck('model:m1', old);
    await processor.recoverStuck(120_000);
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PAID');
    expect(psp.sent).toHaveLength(1);
  });

  it('NÃO toca PROCESSING recente (dentro do limiar)', async () => {
    const id = await stuck('model:m2', new Date()); // agora
    await processor.recoverStuck(120_000);
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PROCESSING');
    expect(psp.sent).toHaveLength(0);
  });

  it('recupera PROCESSING legado (processingAt null)', async () => {
    const id = await stuck('model:m3', null);
    await processor.recoverStuck(120_000);
    expect((await prisma.payout.findUnique({ where: { id } }))?.status).toBe('PAID');
  });

  it('falha de PSP no recovery → FAILED + estorno no ledger', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const id = await stuck('model:m4', old);
    psp.failNext();
    await processor.recoverStuck(120_000);
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('FAILED');
    expect(await bal('model:m4')).toBe('100'); // estorno creditou de volta
  });

  it('processPending carimba processingAt ao reivindicar', async () => {
    await prisma.payout.create({ data: { account: 'model:m5', amount: new Prisma.Decimal('100.00'), status: 'PENDING', pixKey: 'k' } });
    await processor.processPending();
    const p = await prisma.payout.findFirst({ where: { account: 'model:m5' } });
    expect(p?.status).toBe('PAID');
    expect(p?.processingAt).not.toBeNull();
  });
});
