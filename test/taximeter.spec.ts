import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TaximeterService } from '../src/scheduler/taximeter.service';

describe('TaximeterService.runDueCharges', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let taximeter: TaximeterService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    taximeter = mod.get(TaximeterService);
  });
  beforeEach(async () => {
    await prisma.gift.deleteMany();
    await prisma.giftType.deleteMany();
    await prisma.call.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function setup(opts: { price?: string; credit?: string; startedSecAgo?: number }): Promise<{ callId: string; clientId: string }> {
    const model = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `ms-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: model.id, stageName: 'S', pricePerMinute: new Prisma.Decimal(opts.price ?? '5.00'), tags: [] } });
    const client = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `cs-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    if (opts.credit) {
      await ledger.postTransaction(`seed:${client.id}`, [
        { account: `client:${client.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal(opts.credit) },
        { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(opts.credit).negated() },
      ]);
    }
    const startedAt = new Date(Date.now() - (opts.startedSecAgo ?? 0) * 1000);
    const call = await prisma.call.create({ data: { clientUserId: client.id, modelUserId: model.id, status: 'ACTIVE', pricePerMinuteSnapshot: new Prisma.Decimal(opts.price ?? '5.00'), startedAt } });
    return { callId: call.id, clientId: client.id };
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('cobra todos os minutos devidos (1..3) de uma chamada 130s ativa', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 130 });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('35'); // 50 - 3*5
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(3);
    expect(call?.status).toBe('ACTIVE');
  });

  it('encerra em NO_CREDITS quando o saldo acaba no meio', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '10.00', startedSecAgo: 130 });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('0'); // cobrou min1+min2
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.status).toBe('ENDED');
    expect(call?.endReason).toBe('NO_CREDITS');
    expect(call?.billedMinutes).toBe(2);
  });

  it('idempotente: rodar de novo não cobra de novo', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 130 });
    await taximeter.runDueCharges();
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('35');
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(3);
  });

  it('ignora chamadas não-ACTIVE', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 130 });
    await prisma.call.update({ where: { id: callId }, data: { status: 'ENDED', endReason: 'HANGUP_CLIENT' } });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('50');
  });

  it('chamada recém-iniciada cobra só o minuto 1', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 0 });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('45');
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(1);
  });
});
