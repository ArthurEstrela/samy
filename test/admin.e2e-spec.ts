import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Admin endpoints', () => {
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

  async function adminToken(): Promise<string> {
    fake.register('tok-admin', { provider: 'google', subject: 'admin1', email: 'admin@x.com', name: 'Admin' });
    // cria como CLIENT pelo fluxo e promove direto no banco para ADMIN
    await http().post('/auth/google').send({ idToken: 'tok-admin', role: 'CLIENT' });
    const u = await prisma.user.findFirst({ where: { providerSubject: 'admin1' } });
    await prisma.user.update({ where: { id: u!.id }, data: { role: 'ADMIN' } });
    const res = await http().post('/auth/google').send({ idToken: 'tok-admin' });
    return res.body.accessToken;
  }

  async function makeModel(sub: string): Promise<string> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    await http().post('/auth/google').send({ idToken: `tok-${sub}`, role: 'MODEL' });
    const u = await prisma.user.findFirst({ where: { providerSubject: sub } });
    return u!.id;
  }

  it('admin ativa uma modelo PENDING → ACTIVE', async () => {
    const token = await adminToken();
    const modelId = await makeModel('mod1');
    await http().post(`/admin/users/${modelId}/activate`).set('Authorization', `Bearer ${token}`).expect(201);
    const u = await prisma.user.findUnique({ where: { id: modelId } });
    expect(u?.status).toBe('ACTIVE');
  });

  it('admin suspende usuário; inexistente → 404', async () => {
    const token = await adminToken();
    const modelId = await makeModel('mod2');
    await http().post(`/admin/users/${modelId}/suspend`).set('Authorization', `Bearer ${token}`).expect(201);
    expect((await prisma.user.findUnique({ where: { id: modelId } }))?.status).toBe('SUSPENDED');
    await http().post(`/admin/users/00000000-0000-0000-0000-000000000000/suspend`)
      .set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('sem token → 401 (rota admin exige autenticação)', async () => {
    const modelId = await makeModel('mod3');
    await http().post(`/admin/users/${modelId}/activate`).expect(401);
    const u = await prisma.user.findUnique({ where: { id: modelId } });
    expect(u?.status).toBe('PENDING_VERIFICATION');
  });

  it('token de CLIENT → 403 (rota admin exige papel ADMIN)', async () => {
    fake.register('tok-client', { provider: 'google', subject: 'client1', email: 'client@x.com', name: 'C' });
    const reg = await http().post('/auth/google').send({ idToken: 'tok-client', role: 'CLIENT' }).expect(201);
    const clientToken = reg.body.accessToken;
    const modelId = await makeModel('mod4');
    await http().post(`/admin/users/${modelId}/suspend`).set('Authorization', `Bearer ${clientToken}`).expect(403);
    const u = await prisma.user.findUnique({ where: { id: modelId } });
    expect(u?.status).toBe('PENDING_VERIFICATION');
  });
});
