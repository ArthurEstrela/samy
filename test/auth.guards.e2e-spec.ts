import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Auth guards', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = mod.get(PrismaService);
    fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fake.reset();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function loginClient(sub: string): Promise<string> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role: 'CLIENT' });
    return res.body.accessToken;
  }

  it('/auth/me sem token → 401; com token → usuário', async () => {
    await http().get('/auth/me').expect(401);
    const access = await loginClient('me1');
    const res = await http().get('/auth/me').set('Authorization', `Bearer ${access}`).expect(200);
    expect(res.body).toMatchObject({ role: 'CLIENT', status: 'ACTIVE' });
  });

  it('status fresco: suspender invalida o MESMO access token (403)', async () => {
    const access = await loginClient('me2');
    const user = await prisma.user.findFirst({ where: { providerSubject: 'me2' } });
    await prisma.user.update({ where: { id: user!.id }, data: { status: 'SUSPENDED' } });
    await http().get('/auth/me').set('Authorization', `Bearer ${access}`).expect(403);
  });

  it('RolesGuard: CLIENT no endpoint admin → 403', async () => {
    const access = await loginClient('me3');
    const user = await prisma.user.findFirst({ where: { providerSubject: 'me3' } });
    await http().post(`/admin/users/${user!.id}/suspend`).set('Authorization', `Bearer ${access}`).expect(403);
  });
});
