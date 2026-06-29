import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('Payout API', () => {
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
    await prisma.payout.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN; else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  async function model(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'MODEL' }) };
  }
  async function fund(account: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${account}:${amount}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }

  it('com KYC aprovado e saldo, POST /payouts cria PENDING e debita', async () => {
    const m = await model();
    await prisma.kycStatus.create({ data: { account: `model:${m.id}`, approved: true } });
    await fund(`model:${m.id}`, '300.00');
    const res = await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '300.00', pixKey: 'chave@x.com' }).expect(201);
    expect(res.body.status).toBe('PENDING');
    expect((await ledger.getBalance(`model:${m.id}`)).toString()).toBe('0');
  });

  it('sem KYC aprovado → 403', async () => {
    const m = await model();
    await fund(`model:${m.id}`, '300.00');
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '300.00', pixKey: 'k' }).expect(403);
  });

  it('abaixo do mínimo → 400', async () => {
    const m = await model();
    await prisma.kycStatus.create({ data: { account: `model:${m.id}`, approved: true } });
    await fund(`model:${m.id}`, '300.00');
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '50.00', pixKey: 'k' }).expect(400);
  });

  it('GET /payouts lista os saques da modelo', async () => {
    const m = await model();
    await prisma.kycStatus.create({ data: { account: `model:${m.id}`, approved: true } });
    await fund(`model:${m.id}`, '300.00');
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '300.00', pixKey: 'k' }).expect(201);
    const res = await request(app.getHttpServer()).get('/payouts').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].pixKey).toBe('k');
  });

  it('dev-grant (DEV_LOGIN=true) credita ganhos e aprova KYC; depois o saque passa', async () => {
    process.env.DEV_LOGIN = 'true';
    const m = await model();
    await request(app.getHttpServer()).post('/payouts/dev-grant').set('Authorization', `Bearer ${m.token}`).expect(201);
    expect((await ledger.getBalance(`model:${m.id}`)).greaterThan(new Prisma.Decimal('200'))).toBe(true);
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '200.00', pixKey: 'k' }).expect(201);
  });

  it('dev-grant desligado → 404', async () => {
    delete process.env.DEV_LOGIN;
    const m = await model();
    await request(app.getHttpServer()).post('/payouts/dev-grant').set('Authorization', `Bearer ${m.token}`).expect(404);
  });
});
