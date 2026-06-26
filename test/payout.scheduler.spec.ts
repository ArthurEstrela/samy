import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycModule } from '../src/kyc/kyc.module';
import { PayoutModule } from '../src/payout/payout.module';
import { PayoutService } from '../src/payout/payout.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { PayoutScheduler } from '../src/scheduler/payout.scheduler';
import { PSP_PAYOUT_PORT } from '../src/payout/psp-payout.port';
import { FakePspPayoutPort } from '../src/payout/fake-psp-payout.adapter';

describe('PayoutScheduler gate', () => {
  let scheduler: PayoutScheduler;
  let payoutSvc: PayoutService;
  let ledger: LedgerService;
  let prisma: PrismaService;
  let fakePsp: FakePspPayoutPort;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, KycModule, PayoutModule, SchedulerModule],
    })
      .overrideProvider(PSP_PAYOUT_PORT)
      .useClass(FakePspPayoutPort)
      .compile();
    scheduler = mod.get(PayoutScheduler);
    payoutSvc = mod.get(PayoutService);
    ledger = mod.get(LedgerService);
    prisma = mod.get(PrismaService);
    fakePsp = mod.get(PSP_PAYOUT_PORT);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.payout.deleteMany();
    await prisma.kycStatus.deleteMany();
    fakePsp.reset();
    delete process.env.SCHEDULERS_ENABLED;
  });
  afterAll(async () => {
    delete process.env.SCHEDULERS_ENABLED;
    await prisma.$disconnect();
  });

  async function seedPending(account: string): Promise<string> {
    await prisma.kycStatus.create({ data: { account, approved: true } });
    await ledger.postTransaction(`seed:${account}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('300.00') },
      { account: 'source:external', entryType: 'SEED_OFFSET', amount: new Prisma.Decimal('-300.00') },
    ]);
    const p = await payoutSvc.requestPayout(account, new Prisma.Decimal('300.00'), 'k');
    return p.id;
  }

  it('habilitado: handleTick processa o PENDING (vira PAID)', async () => {
    const id = await seedPending('model:sch1');
    process.env.SCHEDULERS_ENABLED = 'true';
    await scheduler.handleTick();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PAID');
    expect(fakePsp.sent).toHaveLength(1);
  });

  it('desabilitado: handleTick não toca o PENDING', async () => {
    const id = await seedPending('model:sch2');
    process.env.SCHEDULERS_ENABLED = 'false';
    await scheduler.handleTick();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PENDING');
    expect(fakePsp.sent).toHaveLength(0);
  });
});
