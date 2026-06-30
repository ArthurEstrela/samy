import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('GET /admin/users', () => {
  let app: INestApplication; let prisma: PrismaService; let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider).compile();
    app = mod.createNestApplication({ rawBody: true }); await app.init();
    prisma = mod.get(PrismaService); fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => { fake.reset(); await prisma.refreshToken.deleteMany(); await prisma.modelProfile.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });
  function http() { return request(app.getHttpServer()); }

  async function adminToken(): Promise<string> {
    fake.register('tok-admin', { provider: 'google', subject: 'admin1', email: 'admin@x.com', name: 'Admin' });
    await http().post('/auth/google').send({ idToken: 'tok-admin', role: 'CLIENT' });
    const u = await prisma.user.findFirst({ where: { providerSubject: 'admin1' } });
    await prisma.user.update({ where: { id: u!.id }, data: { role: 'ADMIN' } });
    const res = await http().post('/auth/google').send({ idToken: 'tok-admin' });
    return res.body.accessToken;
  }
  async function makeUser(sub: string, role: string): Promise<string> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    const u = await prisma.user.findFirst({ where: { providerSubject: sub } });
    return u!.id;
  }

  it('admin lista usuários e filtra por status', async () => {
    const token = await adminToken();
    await makeUser('mod1', 'MODEL');   // PENDING_VERIFICATION
    await makeUser('cli1', 'CLIENT');  // ACTIVE

    const all = await http().get('/admin/users').set('Authorization', `Bearer ${token}`).expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(3); // admin + mod + cli
    expect(all.body[0]).toHaveProperty('email');
    expect(all.body[0]).toHaveProperty('status');

    const pending = await http().get('/admin/users?status=PENDING_VERIFICATION').set('Authorization', `Bearer ${token}`).expect(200);
    expect(pending.body.every((u: { status: string }) => u.status === 'PENDING_VERIFICATION')).toBe(true);
    expect(pending.body).toHaveLength(1);
  });

  it('não-admin → 403', async () => {
    fake.register('tok-c', { provider: 'google', subject: 'c2', email: 'c2@x.com', name: 'C2' });
    const res = await http().post('/auth/google').send({ idToken: 'tok-c', role: 'CLIENT' });
    await http().get('/admin/users').set('Authorization', `Bearer ${res.body.accessToken}`).expect(403);
  });

  it('sem token → 401', async () => {
    await http().get('/admin/users').expect(401);
  });

  it('dev-login ADMIN retorna usuário ADMIN', async () => {
    const res = await http().post('/auth/dev-login').send({ role: 'ADMIN' }).expect(201);
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.body.user.status).toBe('ACTIVE');
  });
});
