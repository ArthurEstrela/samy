import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Gifts', () => {
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
    await prisma.gift.deleteMany();
    await prisma.giftType.deleteMany();
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
  async function credit(clientId: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${clientId}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('catálogo lista só os ativos', async () => {
    await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    await prisma.giftType.create({ data: { name: 'Velha', priceCredits: new Prisma.Decimal('1.00'), active: false } });
    const c = await login('c0', 'CLIENT');
    const res = await http().get('/gifts/catalog').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Rosa');
  });

  it('cliente manda gift (split soma-zero) mesmo com modelo OFFLINE', async () => {
    const model = await login('m1', 'MODEL'); // sem presença/perfil → offline
    const gt = await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    const client = await login('c1', 'CLIENT');
    await credit(client.id, '20.00');
    const res = await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: model.id, giftTypeId: gt.id }).expect(201);
    expect(res.body.priceSnapshot).toBe('10');
    expect(await bal(`client:${client.id}`)).toBe('10');
    expect(await bal(`model:${model.id}`)).toBe('6'); // 10 - 40% = 6
    expect(await bal('platform')).toBe('4');
  });

  it('saldo insuficiente → 402', async () => {
    const model = await login('m2', 'MODEL');
    const gt = await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    const client = await login('c2', 'CLIENT');
    await credit(client.id, '5.00');
    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: model.id, giftTypeId: gt.id }).expect(402);
  });

  it('gift inexistente/inativo ou modelo não-MODEL → 404', async () => {
    const client = await login('c3', 'CLIENT');
    await credit(client.id, '20.00');
    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: client.id, giftTypeId: '00000000-0000-0000-0000-000000000000' }).expect(404);
  });

  it('MODEL no POST /gifts → 403', async () => {
    const model = await login('m4', 'MODEL');
    await http().post('/gifts').set('Authorization', `Bearer ${model.token}`).send({ modelId: 'x', giftTypeId: 'y' }).expect(403);
  });
});
