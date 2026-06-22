import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { MEDIA_SERVER } from '../src/calls/media-server.port';
import { FakeMediaServer } from '../src/calls/fake-media-server.adapter';

describe('Call initiate', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let fakeId: FakeIdentityProvider;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .overrideProvider(MEDIA_SERVER).useClass(FakeMediaServer)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
    await prisma.call.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await raw.quit(); await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function makeOnlineModel(sub: string, price = '5.00'): Promise<string> {
    const m = await login(sub, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: `S-${sub}`, pricePerMinute: new Prisma.Decimal(price), tags: [] } });
    await raw.set(`presence:model:${m.id}`, 'ONLINE', 'EX', 30);
    return m.id;
  }
  async function credit(clientId: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${clientId}:${amount}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }

  it('cliente com saldo liga p/ modelo online → REQUESTED', async () => {
    const modelId = await makeOnlineModel('mod1');
    const client = await login('cli1', 'CLIENT');
    await credit(client.id, '20.00');
    const res = await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId }).expect(201);
    expect(res.body.status).toBe('REQUESTED');
    expect(res.body.pricePerMinuteSnapshot).toBe('5');
  });

  it('saldo < preço → 402', async () => {
    const modelId = await makeOnlineModel('mod2', '5.00');
    const client = await login('cli2', 'CLIENT');
    await credit(client.id, '3.00');
    await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId }).expect(402);
  });

  it('modelo OFFLINE → 409', async () => {
    const m = await login('mod3', 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: 'S', pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    const client = await login('cli3', 'CLIENT');
    await credit(client.id, '20.00');
    await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: m.id }).expect(409);
  });

  it('modelo inexistente/não-MODEL → 404', async () => {
    const client = await login('cli4', 'CLIENT');
    await credit(client.id, '20.00');
    await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: '00000000-0000-0000-0000-000000000000' }).expect(404);
  });

  it('MODEL no POST /calls → 403', async () => {
    const m = await login('mod5', 'MODEL');
    await http().post('/calls').set('Authorization', `Bearer ${m.token}`).send({ modelId: 'x' }).expect(403);
  });

  it('concorrência: cliente abre 2 chamadas ao mesmo tempo → só 1 REQUESTED', async () => {
    const a = await makeOnlineModel('modA');
    const b = await makeOnlineModel('modB');
    const client = await login('cli6', 'CLIENT');
    await credit(client.id, '20.00');
    const [r1, r2] = await Promise.allSettled([
      http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: a }),
      http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: b }),
    ]);
    const statuses = [r1, r2].map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
    expect(await prisma.call.count({ where: { clientUserId: client.id, status: { not: 'ENDED' } } })).toBe(1);
  });
});
