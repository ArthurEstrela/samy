import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { CallService } from '../src/calls/call.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { MEDIA_SERVER } from '../src/calls/media-server.port';
import { FakeMediaServer } from '../src/calls/fake-media-server.adapter';

describe('Call hangup/panic/end/get', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let calls: CallService;
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
    calls = mod.get(CallService);
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
  async function activeCall(sub: string): Promise<{ callId: string; model: { token: string; id: string }; client: { token: string; id: string } }> {
    const m = await login(`mod-${sub}`, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: `S-${sub}`, pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    await raw.set(`presence:model:${m.id}`, 'ONLINE', 'EX', 30);
    const client = await login(`cli-${sub}`, 'CLIENT');
    await ledger.postTransaction(`seed:${client.id}`, [
      { account: `client:${client.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal('20.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-20.00') },
    ]);
    const req = await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: m.id }).expect(201);
    await http().post(`/calls/${req.body.id}/accept`).set('Authorization', `Bearer ${m.token}`).expect(201);
    return { callId: req.body.id, model: m, client };
  }

  it('cliente faz hangup de uma chamada ATIVA → ENDED(HANGUP_CLIENT)', async () => {
    const { callId, client } = await activeCall('a');
    const res = await http().post(`/calls/${callId}/hangup`).set('Authorization', `Bearer ${client.token}`).expect(201);
    expect(res.body.status).toBe('ENDED');
    expect(res.body.endReason).toBe('HANGUP_CLIENT');
  });

  it('pânico da modelo → ENDED(PANIC)', async () => {
    const { callId, model } = await activeCall('b');
    const res = await http().post(`/calls/${callId}/panic`).set('Authorization', `Bearer ${model.token}`).expect(201);
    expect(res.body.endReason).toBe('PANIC');
  });

  it('GET /calls/:id participante ATIVO recebe token; lazy timeout numa REQUESTED velha', async () => {
    const { callId, client } = await activeCall('c');
    const got = await http().get(`/calls/${callId}`).set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(got.body.media.token).toContain(`call:${callId}`);
    // cria uma REQUESTED velha e confirma timeout lazy no GET
    const m2 = await login('mod-old', 'MODEL');
    await prisma.user.update({ where: { id: m2.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m2.id, stageName: 'old', pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    const cli2 = await login('cli-old', 'CLIENT');
    const old = await prisma.call.create({
      data: { clientUserId: cli2.id, modelUserId: m2.id, status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00'), requestedAt: new Date(Date.now() - 60000) },
    });
    const res = await http().get(`/calls/${old.id}`).set('Authorization', `Bearer ${cli2.token}`).expect(200);
    expect(res.body.call.status).toBe('ENDED');
    expect(res.body.call.endReason).toBe('TIMEOUT');
  });

  it('endCall(NO_CREDITS) encerra a ATIVA e é idempotente', async () => {
    const { callId } = await activeCall('d');
    await calls.endCall(callId, 'NO_CREDITS');
    expect((await prisma.call.findUnique({ where: { id: callId } }))?.endReason).toBe('NO_CREDITS');
    await calls.endCall(callId, 'NO_CREDITS'); // idempotente, sem erro
  });

  it('não-participante no GET → 403', async () => {
    const { callId } = await activeCall('e');
    const intruso = await login('intruso', 'CLIENT');
    await http().get(`/calls/${callId}`).set('Authorization', `Bearer ${intruso.token}`).expect(403);
  });
});
