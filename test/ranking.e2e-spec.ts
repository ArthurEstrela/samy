import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Ranking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let fakeId: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  // ganho bruto histórico pra modelo (entrada positiva isolada, soma-zero com um sink)
  async function earn(modelId: string, amount: string, ref: string): Promise<void> {
    await ledger.postTransaction(`seed-earn:${ref}`, [
      { account: `model:${modelId}`, entryType: 'GANHO_MIN', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  async function profile(modelId: string, stageName: string): Promise<void> {
    await prisma.modelProfile.create({ data: { userId: modelId, stageName, pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
  }

  it('GET /ranking/me reflete o tier pelo ganho bruto', async () => {
    const m = await login('m1', 'MODEL');
    await profile(m.id, 'Lara');
    await earn(m.id, '800.00', 'm1'); // >= 500 → PRATA
    const res = await http().get('/ranking/me').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.tier).toBe('PRATA');
    expect(res.body.earned).toBe('800.00');
    expect(res.body.nextTier).toBe('OURO');
  });

  it('GET /ranking/me por não-modelo → 403', async () => {
    const c = await login('c1', 'CLIENT');
    await http().get('/ranking/me').set('Authorization', `Bearer ${c.token}`).expect(403);
  });

  it('GET /ranking/top ordena por ganho desc e não vaza displayName/valores', async () => {
    const a = await login('ma', 'MODEL'); await profile(a.id, 'Lara'); await earn(a.id, '3000.00', 'ma');
    const b = await login('mb', 'MODEL'); await profile(b.id, 'Bianca'); await earn(b.id, '600.00', 'mb');
    const c = await login('c2', 'CLIENT');
    const res = await http().get('/ranking/top?limit=10').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].stageName).toBe('Lara'); // maior ganho primeiro
    expect(res.body[0].rank).toBe(1);
    expect(res.body[0].tier).toBe('OURO');
    expect(res.body[0]).not.toHaveProperty('displayName');
    expect(res.body[0]).not.toHaveProperty('earned');
  });
});
