import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /wallet/balance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function client(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'CLIENT' }) };
  }

  it('retorna o saldo do cliente autenticado', async () => {
    const c = await client();
    await ledger.postTransaction(`seed:${c.id}`, [
      { account: `client:${c.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal('30.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-30.00') },
    ]);
    const res = await request(app.getHttpServer()).get('/wallet/balance').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body.balance).toBe('30');
  });

  it('saldo zero quando não há lançamentos', async () => {
    const c = await client();
    const res = await request(app.getHttpServer()).get('/wallet/balance').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body.balance).toBe('0');
  });

  it('sem token → 401', async () => {
    await request(app.getHttpServer()).get('/wallet/balance').expect(401);
  });
});
