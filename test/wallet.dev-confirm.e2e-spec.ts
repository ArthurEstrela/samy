import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('POST /wallet/recharge/:id/dev-confirm', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let tokens: TokenService;
  const prev = process.env.DEV_LOGIN;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.recharge.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN; else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  async function clientWithPending(): Promise<{ id: string; token: string; rechargeId: string }> {
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    const r = await prisma.recharge.create({ data: { userId: u.id, amount: new Prisma.Decimal('20.00'), status: 'PENDING', pspChargeId: `chg-${u.id}` } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'CLIENT' }), rechargeId: r.id };
  }

  it('com DEV_LOGIN=true confirma a recarga e credita o saldo', async () => {
    process.env.DEV_LOGIN = 'true';
    const c = await clientWithPending();
    await request(app.getHttpServer()).post(`/wallet/recharge/${c.rechargeId}/dev-confirm`).set('Authorization', `Bearer ${c.token}`).expect(201);
    expect((await ledger.getBalance(`client:${c.id}`)).toString()).toBe('20');
    const r = await prisma.recharge.findUnique({ where: { id: c.rechargeId } });
    expect(r?.status).toBe('PAID');
  });

  it('com DEV_LOGIN desativado → 404', async () => {
    delete process.env.DEV_LOGIN;
    const c = await clientWithPending();
    await request(app.getHttpServer()).post(`/wallet/recharge/${c.rechargeId}/dev-confirm`).set('Authorization', `Bearer ${c.token}`).expect(404);
    expect((await ledger.getBalance(`client:${c.id}`)).toString()).toBe('0');
  });

  it('recarga de outro usuário → 404', async () => {
    process.env.DEV_LOGIN = 'true';
    const owner = await clientWithPending();
    const other = await prisma.user.create({ data: { id: `o-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'o@x.com', displayName: 'O', status: 'ACTIVE' } });
    const otherToken = tokens.signAccess({ id: other.id, role: 'CLIENT' });
    await request(app.getHttpServer()).post(`/wallet/recharge/${owner.rechargeId}/dev-confirm`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  });
});
