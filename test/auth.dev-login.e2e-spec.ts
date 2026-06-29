import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('POST /auth/dev-login', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const prev = process.env.DEV_LOGIN;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
  });
  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany({ where: { provider: 'dev' } });
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN;
    else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  it('com DEV_LOGIN=true devolve sessão CLIENT', async () => {
    process.env.DEV_LOGIN = 'true';
    const res = await request(app.getHttpServer()).post('/auth/dev-login').expect(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.role).toBe('CLIENT');
    expect(res.body.user.email).toBe('dev@samy.local');
  });

  it('reutiliza o mesmo CLIENT dev em chamadas repetidas', async () => {
    process.env.DEV_LOGIN = 'true';
    const a = await request(app.getHttpServer()).post('/auth/dev-login').expect(201);
    const b = await request(app.getHttpServer()).post('/auth/dev-login').expect(201);
    expect(a.body.user.id).toBe(b.body.user.id);
  });

  it('com DEV_LOGIN desativado responde 404', async () => {
    delete process.env.DEV_LOGIN;
    await request(app.getHttpServer()).post('/auth/dev-login').expect(404);
  });
});
