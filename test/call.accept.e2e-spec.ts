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

describe('Call accept/reject', () => {
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
  async function onlineModel(sub: string): Promise<{ token: string; id: string }> {
    const m = await login(sub, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: `S-${sub}`, pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    await raw.set(`presence:model:${m.id}`, 'ONLINE', 'EX', 30);
    return m;
  }
  async function credit(clientId: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${clientId}:${amount}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  async function ring(modelSub: string): Promise<{ callId: string; model: { token: string; id: string }; client: { token: string; id: string } }> {
    const model = await onlineModel(modelSub);
    const client = await login(`cli-${modelSub}`, 'CLIENT');
    await credit(client.id, '20.00');
    const res = await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: model.id }).expect(201);
    return { callId: res.body.id, model, client };
  }

  it('modelo aceita → ACTIVE + token de mídia', async () => {
    const { callId, model } = await ring('m1');
    const res = await http().post(`/calls/${callId}/accept`).set('Authorization', `Bearer ${model.token}`).expect(201);
    expect(res.body.call.status).toBe('ACTIVE');
    expect(res.body.call.roomName).toBe(`call:${callId}`);
    expect(res.body.media.token).toContain(`call:${callId}`);
  });

  it('modelo rejeita → ENDED(REJECTED)', async () => {
    const { callId, model } = await ring('m2');
    const res = await http().post(`/calls/${callId}/reject`).set('Authorization', `Bearer ${model.token}`).expect(201);
    expect(res.body.status).toBe('ENDED');
    expect(res.body.endReason).toBe('REJECTED');
  });

  it('CLIENT no accept → 403', async () => {
    const { callId, client } = await ring('m3');
    await http().post(`/calls/${callId}/accept`).set('Authorization', `Bearer ${client.token}`).expect(403);
  });

  it('re-check: saldo sumiu antes do accept → 402 e call ENDED(NO_CREDITS)', async () => {
    const { callId, model, client } = await ring('m4');
    // zera o saldo do cliente (debita tudo) antes do accept
    await ledger.postTransaction(`drain:${client.id}`, [
      { account: `client:${client.id}`, entryType: 'CONSUMO', amount: new Prisma.Decimal('-20.00') },
      { account: 'source:external', entryType: 'DRAIN', amount: new Prisma.Decimal('20.00') },
    ]);
    await http().post(`/calls/${callId}/accept`).set('Authorization', `Bearer ${model.token}`).expect(402);
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.status).toBe('ENDED');
    expect(call?.endReason).toBe('NO_CREDITS');
  });
});
