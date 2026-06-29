import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /wallet/earnings', () => {
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
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });

  async function model(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'MODEL' }) };
  }

  it('retorna o saldo de ganhos da modelo (model:<id>)', async () => {
    const m = await model();
    await ledger.postTransaction(`seed:${m.id}`, [
      { account: `model:${m.id}`, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('120.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-120.00') },
    ]);
    const res = await request(app.getHttpServer()).get('/wallet/earnings').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.balance).toBe('120');
  });

  it('CLIENT não acessa earnings (403)', async () => {
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    const token = tokens.signAccess({ id: u.id, role: 'CLIENT' });
    await request(app.getHttpServer()).get('/wallet/earnings').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
