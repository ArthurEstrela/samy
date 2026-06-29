import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('POST /kyc/dev-approve', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  const prev = process.env.DEV_LOGIN;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.kycVerification.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN; else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  async function model(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'PENDING_VERIFICATION' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'MODEL' }) };
  }

  it('dev-approve (DEV_LOGIN=true) aprova KYC e promove o user a ACTIVE', async () => {
    process.env.DEV_LOGIN = 'true';
    const m = await model();
    await request(app.getHttpServer()).post('/kyc/dev-approve').set('Authorization', `Bearer ${m.token}`).expect(201);
    const status = await request(app.getHttpServer()).get('/kyc/me').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(status.body.status).toBe('APPROVED');
    const ks = await prisma.kycStatus.findUnique({ where: { account: `model:${m.id}` } });
    expect(ks?.approved).toBe(true);
    const u = await prisma.user.findUnique({ where: { id: m.id } });
    expect(u?.status).toBe('ACTIVE');
  });

  it('dev-approve desligado → 404', async () => {
    delete process.env.DEV_LOGIN;
    const m = await model();
    await request(app.getHttpServer()).post('/kyc/dev-approve').set('Authorization', `Bearer ${m.token}`).expect(404);
  });

  it('CLIENT em /kyc/dev-approve → 403', async () => {
    process.env.DEV_LOGIN = 'true';
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    const token = tokens.signAccess({ id: u.id, role: 'CLIENT' });
    await request(app.getHttpServer()).post('/kyc/dev-approve').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
