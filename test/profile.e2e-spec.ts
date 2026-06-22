import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Profile', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.favorite.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<string> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return res.body.accessToken;
  }

  it('MODEL faz upsert e lê o próprio perfil', async () => {
    const token = await login('mod1', 'MODEL');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ stageName: 'Luna', bio: 'oi', pricePerMinute: '5.00', tags: ['noturno'], voicePreviewUrl: 'https://cdn.x/a.mp3' })
      .expect(200);
    const got = await http().get('/me/profile').set('Authorization', `Bearer ${token}`).expect(200);
    expect(got.body.stageName).toBe('Luna');
    expect(got.body.pricePerMinute).toBe('5');
    expect(got.body.tags).toEqual(['noturno']);
  });

  it('GET /me/profile sem perfil → 404', async () => {
    const token = await login('mod2', 'MODEL');
    await http().get('/me/profile').set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('stageName ausente/vazio → 400', async () => {
    const token = await login('mod3b', 'MODEL');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ pricePerMinute: '5.00' }).expect(400);
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ stageName: '   ', pricePerMinute: '5.00' }).expect(400);
  });

  it('pricePerMinute <= 0 → 400; voicePreviewUrl inválida → 400', async () => {
    const token = await login('mod3', 'MODEL');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ stageName: 'Luna', pricePerMinute: '0' }).expect(400);
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ stageName: 'Luna', pricePerMinute: '5.00', voicePreviewUrl: 'not-a-url' }).expect(400);
  });

  it('CLIENT em /me/profile → 403; sem token → 401', async () => {
    const token = await login('cli1', 'CLIENT');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`).send({ stageName: 'X', pricePerMinute: '5.00' }).expect(403);
    await http().get('/me/profile').expect(401);
  });

  it('tags: string (not array) → 400', async () => {
    const token = await login('mod4', 'MODEL');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ pricePerMinute: '5.00', tags: 'notarray' })
      .expect(400);
  });

  it('tags: [1, 2] (numbers, not strings) → 400', async () => {
    const token = await login('mod5', 'MODEL');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ pricePerMinute: '5.00', tags: [1, 2] })
      .expect(400);
  });
});
