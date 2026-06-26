import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycModule } from '../src/kyc/kyc.module';
import { PayoutModule } from '../src/payout/payout.module';
import { PayoutService } from '../src/payout/payout.service';
import { PayoutProcessor } from '../src/payout/payout.processor';
import { PSP_PAYOUT_PORT } from '../src/payout/psp-payout.port';
import { FakePspPayoutPort } from '../src/payout/fake-psp-payout.adapter';

describe('PayoutProcessor', () => {
  let processor: PayoutProcessor;
  let payoutSvc: PayoutService;
  let ledger: LedgerService;
  let prisma: PrismaService;
  let fakePsp: FakePspPayoutPort;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, KycModule, PayoutModule],
    })
      .overrideProvider(PSP_PAYOUT_PORT)
      .useClass(FakePspPayoutPort)
      .compile();
    processor = moduleRef.get(PayoutProcessor);
    payoutSvc = moduleRef.get(PayoutService);
    ledger = moduleRef.get(LedgerService);
    prisma = moduleRef.get(PrismaService);
    fakePsp = moduleRef.get(PSP_PAYOUT_PORT);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.payout.deleteMany();
    await prisma.kycStatus.deleteMany();
    fakePsp.reset();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function seedAndRequest(account: string): Promise<string> {
    await prisma.kycStatus.create({ data: { account, approved: true } });
    await ledger.postTransaction(`seed:${account}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('300.00') },
      { account: 'source:external', entryType: 'SEED_OFFSET', amount: new Prisma.Decimal('-300.00') },
    ]);
    const p = await payoutSvc.requestPayout(account, new Prisma.Decimal('300.00'), 'k');
    return p.id;
  }

  it('marca PAID e chama o PSP com a idempotencyKey em sucesso', async () => {
    const id = await seedAndRequest('model:2');
    await processor.processPending();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PAID');
    expect(p?.processedAt).not.toBeNull();
    expect(fakePsp.sent).toHaveLength(1);
    expect(fakePsp.sent[0]).toMatchObject({
      pixKey: 'k',
      amount: '300',
      idempotencyKey: id,
    });
    expect((await ledger.getBalance('model:2')).toString()).toBe('0');
  });

  it('em falha do PSP: marca FAILED e estorna o saldo', async () => {
    const id = await seedAndRequest('model:3');
    fakePsp.failNext();
    await processor.processPending();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('FAILED');
    expect(p?.processedAt).not.toBeNull();
    expect((await ledger.getBalance('model:3')).toString()).toBe('300');
  });

  it('não reprocessa um payout já reivindicado (não PENDING)', async () => {
    const id = await seedAndRequest('model:7');
    // simula outro worker que já reivindicou: status PROCESSING
    await prisma.payout.update({ where: { id }, data: { status: 'PROCESSING' } });
    await processor.processPending();
    expect(fakePsp.sent).toHaveLength(0);
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PROCESSING');
  });
});
