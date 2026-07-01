import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Reports (e2e)', () => {
  let app: INestApplication; let prisma: PrismaService; let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider).compile();
    app = mod.createNestApplication({ rawBody: true }); await app.init();
    prisma = mod.get(PrismaService); fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => { fake.reset(); await prisma.report.deleteMany(); await prisma.refreshToken.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });
  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function adminToken(): Promise<string> {
    fake.register('tok-a', { provider: 'google', subject: 'a1', email: 'a@x.com', name: 'A' });
    await http().post('/auth/google').send({ idToken: 'tok-a', role: 'CLIENT' });
    const u = await prisma.user.findFirst({ where: { providerSubject: 'a1' } });
    await prisma.user.update({ where: { id: u!.id }, data: { role: 'ADMIN' } });
    return (await http().post('/auth/google').send({ idToken: 'tok-a' })).body.accessToken;
  }

  it('cliente denuncia acompanhante → OPEN', async () => {
    const c = await login('c1', 'CLIENT');
    const m = await login('m1', 'MODEL');
    const res = await http().post('/reports').set('Authorization', `Bearer ${c.token}`)
      .send({ reportedUserId: m.id, reason: 'EXPLICITO', details: 'passou da linha' }).expect(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.reportedUserId).toBe(m.id);
  });

  it('auto-denúncia → 400', async () => {
    const c = await login('c2', 'CLIENT');
    await http().post('/reports').set('Authorization', `Bearer ${c.token}`)
      .send({ reportedUserId: c.id, reason: 'OUTRO' }).expect(400);
  });

  it('alvo inexistente → 404', async () => {
    const c = await login('c3', 'CLIENT');
    await http().post('/reports').set('Authorization', `Bearer ${c.token}`)
      .send({ reportedUserId: '00000000-0000-0000-0000-000000000000', reason: 'OUTRO' }).expect(404);
  });

  it('sem token → 401', async () => {
    await http().post('/reports').send({ reportedUserId: 'x', reason: 'OUTRO' }).expect(401);
  });

  it('admin lista abertas e resolve; não-admin → 403', async () => {
    const c = await login('c4', 'CLIENT');
    const m = await login('m4', 'MODEL');
    await http().post('/reports').set('Authorization', `Bearer ${c.token}`).send({ reportedUserId: m.id, reason: 'ASSEDIO' }).expect(201);
    const token = await adminToken();

    await http().get('/admin/reports').set('Authorization', `Bearer ${c.token}`).expect(403);

    const list = await http().get('/admin/reports').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(1);
    const id = list.body[0].id;
    expect(list.body[0].reportedName).toBeDefined();

    await http().post(`/admin/reports/${id}/resolve`).set('Authorization', `Bearer ${token}`).send({ status: 'DISMISSED' }).expect(201);
    const after = await http().get('/admin/reports').set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body).toHaveLength(0);
  });
});
