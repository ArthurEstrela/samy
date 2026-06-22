import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Discovery', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
    await prisma.favorite.deleteMany();
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
  // cria um MODEL ACTIVE com perfil; retorna id. createdAt controlado para testar recência.
  async function makeModel(sub: string, opts: { tags?: string[]; createdAt?: Date } = {}): Promise<string> {
    const m = await login(sub, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({
      data: { userId: m.id, pricePerMinute: new Prisma.Decimal('5.00'), tags: opts.tags ?? [], createdAt: opts.createdAt ?? new Date() },
    });
    return m.id;
  }

  it('lista só ACTIVE-com-perfil (PENDING e sem-perfil não aparecem)', async () => {
    const active = await makeModel('a1');
    await login('p1', 'MODEL'); // PENDING_VERIFICATION, sem perfil
    const client = await login('c1', 'CLIENT');
    const res = await http().get('/models').set('Authorization', `Bearer ${client.token}`).expect(200);
    const ids = res.body.map((c: { userId: string }) => c.userId);
    expect(ids).toContain(active);
    expect(ids).toHaveLength(1);
  });

  it('filtra por tags (hasEvery)', async () => {
    const noturno = await makeModel('a2', { tags: ['noturno', 'voz-suave'] });
    await makeModel('a3', { tags: ['diurno'] });
    const client = await login('c2', 'CLIENT');
    const res = await http().get('/models?tags=noturno').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(res.body.map((c: { userId: string }) => c.userId)).toEqual([noturno]);
  });

  it('paradoxo paginação×presença: ONLINE antiga vem na página 1 antes de OFFLINE recentes', async () => {
    const onlineOld = await makeModel('old', { createdAt: new Date('2020-01-01') });
    await makeModel('new1', { createdAt: new Date('2026-01-01') });
    await makeModel('new2', { createdAt: new Date('2026-02-01') });
    await raw.set(`presence:model:${onlineOld}`, 'ONLINE', 'EX', 30);
    const client = await login('c3', 'CLIENT');
    const res = await http().get('/models?limit=1').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userId).toBe(onlineOld);
    expect(res.body[0].isOnline).toBe(true);
  });

  it('marca isFavorite para o cliente', async () => {
    const m = await makeModel('a4');
    const client = await login('c4', 'CLIENT');
    await http().post(`/favorites/${m}`).set('Authorization', `Bearer ${client.token}`).expect(201);
    const res = await http().get('/models').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(res.body[0].isFavorite).toBe(true);
  });

  it('GET /models/:id ACTIVE → card; inexistente/PENDING → 404', async () => {
    const m = await makeModel('a5');
    const pending = await login('p2', 'MODEL');
    const client = await login('c5', 'CLIENT');
    const ok = await http().get(`/models/${m}`).set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(ok.body.userId).toBe(m);
    await http().get(`/models/${pending.id}`).set('Authorization', `Bearer ${client.token}`).expect(404);
  });

  it('limit fora do range → 400', async () => {
    const client = await login('c6', 'CLIENT');
    await http().get('/models?limit=999').set('Authorization', `Bearer ${client.token}`).expect(400);
  });

  it('limit não-numérico (NaN) → 400, não lista vazia silenciosa', async () => {
    const client = await login('c7', 'CLIENT');
    await http().get('/models?limit=abc').set('Authorization', `Bearer ${client.token}`).expect(400);
  });
});
