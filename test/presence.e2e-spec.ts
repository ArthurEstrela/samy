import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { PresenceService } from '../src/marketplace/presence.service';

describe('Presence', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;
  let presence: PresenceService;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    presence = mod.get(PresenceService);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
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

  it('heartbeat marca a modelo ONLINE; ao limpar a chave volta a OFFLINE', async () => {
    const { token, id } = await login('mod1', 'MODEL');
    await http().post('/me/heartbeat').set('Authorization', `Bearer ${token}`).expect(201);
    expect(await presence.getStatus(id)).toBe('ONLINE');
    await raw.del(`presence:model:${id}`); // simula expiração
    expect(await presence.getStatus(id)).toBe('OFFLINE');
  });

  it('CLIENT no /me/heartbeat → 403', async () => {
    const { token } = await login('cli1', 'CLIENT');
    await http().post('/me/heartbeat').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
