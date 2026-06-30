import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Ranking × Billing split', () => {
  let app: INestApplication; let prisma: PrismaService; let ledger: LedgerService; let fakeId: FakeIdentityProvider;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider).compile();
    app = mod.createNestApplication({ rawBody: true }); await app.init();
    prisma = mod.get(PrismaService); ledger = mod.get(LedgerService); fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.gift.deleteMany(); await prisma.giftType.deleteMany(); await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany(); await prisma.refreshToken.deleteMany(); await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });
  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function credit(clientId: string, amount: string, ref: string): Promise<void> {
    await ledger.postTransaction(`seed:${ref}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('modelo OURO retém mais que BRONZE no mesmo gift', async () => {
    const oura = await login('mo', 'MODEL');   // vai pra OURO
    const bronze = await login('mb', 'MODEL'); // fica BRONZE (ganho 0 antes do gift)
    // ganho bruto histórico de 2000 pra OURO (conta como histórico, não como a entrada corrente)
    await ledger.postTransaction('seed-earn:mo', [
      { account: `model:${oura.id}`, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('2000') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-2000') },
    ]);
    const gt = await prisma.giftType.create({ data: { name: 'Coroa', priceCredits: new Prisma.Decimal('100.00') } });
    const client = await login('c1', 'CLIENT');
    await credit(client.id, '500.00', 'c1');

    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: oura.id, giftTypeId: gt.id }).expect(201);
    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: bronze.id, giftTypeId: gt.id }).expect(201);

    // OURO: ganho corrente = 100 * (1 - 0.20) = 80; o saldo da OURO = 2000 (histórico) + 80
    expect(await bal(`model:${oura.id}`)).toBe('2080');
    // BRONZE: 100 * (1 - 0.40) = 60
    expect(await bal(`model:${bronze.id}`)).toBe('60');
  });
});
