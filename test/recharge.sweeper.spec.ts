import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { RechargeSweeper } from '../src/scheduler/recharge.sweeper';

describe('RechargeSweeper gate', () => {
  let sweeper: RechargeSweeper; let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, SchedulerModule] }).compile();
    sweeper = mod.get(RechargeSweeper); prisma = mod.get(PrismaService);
  });
  beforeEach(async () => { await prisma.recharge.deleteMany(); await prisma.user.deleteMany(); delete process.env.SCHEDULERS_ENABLED; });
  afterAll(async () => { delete process.env.SCHEDULERS_ENABLED; await prisma.$disconnect(); });

  async function expiredPending(): Promise<string> {
    const u = await prisma.user.create({ data: { role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'x@y.com', displayName: 'X', status: 'ACTIVE' } });
    const r = await prisma.recharge.create({ data: { userId: u.id, amount: new Prisma.Decimal('10.00'), status: 'PENDING', expiresAt: new Date(Date.now() - 60_000) } });
    return r.id;
  }

  it('sem SCHEDULERS_ENABLED → não expira', async () => {
    const id = await expiredPending();
    await sweeper.handleTick();
    expect((await prisma.recharge.findUnique({ where: { id } }))?.status).toBe('PENDING');
  });

  it('com SCHEDULERS_ENABLED=true → expira vencidas', async () => {
    process.env.SCHEDULERS_ENABLED = 'true';
    const id = await expiredPending();
    await sweeper.handleTick();
    expect((await prisma.recharge.findUnique({ where: { id } }))?.status).toBe('EXPIRED');
  });
});
