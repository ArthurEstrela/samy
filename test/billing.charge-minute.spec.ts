import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { BillingService } from '../src/billing/billing.service';

describe('BillingService.chargeMinute', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let billing: BillingService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    billing = mod.get(BillingService);
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

  async function setup(opts: { price?: string; credit?: string; takeRate?: string } = {}): Promise<{ callId: string; clientId: string; modelId: string }> {
    const model = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `ms-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: model.id, stageName: 'S', pricePerMinute: new Prisma.Decimal(opts.price ?? '5.00'), tags: [], takeRate: opts.takeRate ? new Prisma.Decimal(opts.takeRate) : null } });
    const client = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `cs-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    if (opts.credit) {
      await ledger.postTransaction(`seed:${client.id}`, [
        { account: `client:${client.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal(opts.credit) },
        { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(opts.credit).negated() },
      ]);
    }
    const call = await prisma.call.create({ data: { clientUserId: client.id, modelUserId: model.id, status: 'ACTIVE', pricePerMinuteSnapshot: new Prisma.Decimal(opts.price ?? '5.00'), startedAt: new Date() } });
    return { callId: call.id, clientId: client.id, modelId: model.id };
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('cobra o split correto (take rate global 0.40) e soma zero', async () => {
    const { callId, clientId, modelId } = await setup({ price: '5.00', credit: '20.00' });
    const r = await billing.chargeMinute(callId, 1);
    expect(r.charged).toBe(true);
    expect(await bal(`client:${clientId}`)).toBe('15');
    expect(await bal(`model:${modelId}`)).toBe('3');
    expect(await bal('platform')).toBe('2');
  });

  it('idempotente: cobrar o mesmo minuto duas vezes debita uma vez só', async () => {
    const { callId, clientId } = await setup({ credit: '20.00' });
    await billing.chargeMinute(callId, 1);
    const r2 = await billing.chargeMinute(callId, 1);
    expect(r2.charged).toBe(false);
    expect(r2.alreadyCharged).toBe(true);
    expect(await bal(`client:${clientId}`)).toBe('15');
  });

  it('saldo insuficiente → encerra a chamada (NO_CREDITS) e não cobra', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '3.00' });
    const r = await billing.chargeMinute(callId, 1);
    expect(r.ended).toBe(true);
    expect(r.charged).toBe(false);
    expect(await bal(`client:${clientId}`)).toBe('3');
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.status).toBe('ENDED');
    expect(call?.endReason).toBe('NO_CREDITS');
  });

  it('não cobra chamada não-ACTIVE', async () => {
    const { callId } = await setup({ credit: '20.00' });
    await prisma.call.update({ where: { id: callId }, data: { status: 'ENDED', endReason: 'HANGUP_CLIENT' } });
    const r = await billing.chargeMinute(callId, 1);
    expect(r.charged).toBe(false);
    expect(r.reason).toBe('not_active');
  });

  it('rounding-safe: preço 5.01 com 0.40 → comissão 2.00, modelo 3.01, soma zero', async () => {
    const { callId, clientId, modelId } = await setup({ price: '5.01', credit: '20.00' });
    await billing.chargeMinute(callId, 1);
    expect(await bal(`model:${modelId}`)).toBe('3.01');
    expect(await bal('platform')).toBe('2');
    expect(await bal(`client:${clientId}`)).toBe('14.99');
  });

  it('override de takeRate (0.30) tem precedência sobre o global', async () => {
    const { callId, modelId } = await setup({ price: '5.00', credit: '20.00', takeRate: '0.30' });
    await billing.chargeMinute(callId, 1);
    expect(await bal('platform')).toBe('1.5');
    expect(await bal(`model:${modelId}`)).toBe('3.5');
  });

  it('serialização: chargeMinute + sendGift concorrentes não estouram o saldo (sem o lock daria -5)', async () => {
    // Saldo cobre EXATAMENTE uma operação de 5; minuto (5) e gift (5) disparados juntos.
    // Sem o advisory lock por cliente, os dois leriam saldo 5 e ambos debitariam -> -5.
    const { callId, clientId, modelId } = await setup({ price: '5.00', credit: '5.00' });
    const gt = await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('5.00') } });
    const [r1, r2] = await Promise.allSettled([
      billing.chargeMinute(callId, 1),
      billing.sendGift(clientId, modelId, gt.id),
    ]);
    // exatamente uma operação debitou (a outra é barrada por saldo): saldo == 0, nunca negativo
    const balance = await ledger.getBalance(`client:${clientId}`);
    expect(balance.toString()).toBe('0');
    expect(balance.greaterThanOrEqualTo(0)).toBe(true);
    // uma das duas teve sucesso, a outra falhou/não-cobrou (não as duas)
    const minuteCharged = r1.status === 'fulfilled' && r1.value.charged === true;
    const giftSent = r2.status === 'fulfilled';
    expect(minuteCharged !== giftSent).toBe(true);
  });
});
