import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Auth flow', () => {
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

  it('cadastra CLIENT (ACTIVE) e devolve tokens', async () => {
    fake.register('tok-c', { provider: 'google', subject: 'c1', email: 'c@x.com', name: 'C' });
    const res = await http().post('/auth/google').send({ idToken: 'tok-c', role: 'CLIENT' }).expect(201);
    expect(res.body.user).toMatchObject({ role: 'CLIENT', status: 'ACTIVE', email: 'c@x.com' });
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('cadastra MODEL como PENDING_VERIFICATION', async () => {
    fake.register('tok-m', { provider: 'google', subject: 'm1', email: 'm@x.com', name: 'M' });
    const res = await http().post('/auth/google').send({ idToken: 'tok-m', role: 'MODEL' }).expect(201);
    expect(res.body.user.status).toBe('PENDING_VERIFICATION');
  });

  it('login de identidade existente ignora role do body (CLIENT continua CLIENT)', async () => {
    fake.register('tok-x', { provider: 'google', subject: 'x1', email: 'x@x.com', name: 'X' });
    await http().post('/auth/google').send({ idToken: 'tok-x', role: 'CLIENT' }).expect(201);
    const res = await http().post('/auth/google').send({ idToken: 'tok-x', role: 'MODEL' }).expect(201);
    expect(res.body.user.role).toBe('CLIENT');
  });

  it('rejeita cadastro com role ADMIN (400)', async () => {
    fake.register('tok-a', { provider: 'google', subject: 'a1', email: 'a@x.com', name: 'A' });
    await http().post('/auth/google').send({ idToken: 'tok-a', role: 'ADMIN' }).expect(400);
  });

  it('idToken inválido → 401', async () => {
    await http().post('/auth/google').send({ idToken: 'nope', role: 'CLIENT' }).expect(401);
  });

  it('refresh rotaciona e o token antigo para de funcionar (401)', async () => {
    fake.register('tok-r', { provider: 'google', subject: 'r1', email: 'r@x.com', name: 'R' });
    const reg = await http().post('/auth/google').send({ idToken: 'tok-r', role: 'CLIENT' }).expect(201);
    const old = reg.body.refreshToken;
    const ref = await http().post('/auth/refresh').send({ refreshToken: old }).expect(201);
    expect(ref.body.refreshToken).not.toBe(old);
    await http().post('/auth/refresh').send({ refreshToken: old }).expect(401);
  });

  it('logout revoga o refresh; uso posterior → 401; logout repetido → 200/201', async () => {
    fake.register('tok-l', { provider: 'google', subject: 'l1', email: 'l@x.com', name: 'L' });
    const reg = await http().post('/auth/google').send({ idToken: 'tok-l', role: 'CLIENT' }).expect(201);
    const rt = reg.body.refreshToken;
    await http().post('/auth/logout').send({ refreshToken: rt }).expect(201);
    await http().post('/auth/refresh').send({ refreshToken: rt }).expect(401);
    await http().post('/auth/logout').send({ refreshToken: rt }).expect(201);
  });
});
