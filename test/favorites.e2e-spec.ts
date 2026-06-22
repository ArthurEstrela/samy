import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Favorites', () => {
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

  it('cliente favorita um modelo, lista e desfavorita (idempotente)', async () => {
    const model = await login('mod1', 'MODEL');
    const client = await login('cli1', 'CLIENT');
    await http().post(`/favorites/${model.id}`).set('Authorization', `Bearer ${client.token}`).expect(201);
    await http().post(`/favorites/${model.id}`).set('Authorization', `Bearer ${client.token}`).expect(201); // idempotente
    const list = await http().get('/favorites').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(list.body).toContain(model.id);
    await http().delete(`/favorites/${model.id}`).set('Authorization', `Bearer ${client.token}`).expect(200);
    const after = await http().get('/favorites').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(after.body).not.toContain(model.id);
  });

  it('favoritar um id que não é MODEL → 404', async () => {
    const client = await login('cli2', 'CLIENT');
    await http().post('/favorites/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${client.token}`).expect(404);
  });

  it('MODEL em /favorites → 403', async () => {
    const model = await login('mod2', 'MODEL');
    await http().get('/favorites').set('Authorization', `Bearer ${model.token}`).expect(403);
  });
});
