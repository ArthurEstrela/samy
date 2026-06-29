import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /calls/incoming', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => { await prisma.call.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });

  async function user(role: 'CLIENT' | 'MODEL'): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `${role}-${Math.random().toString(36).slice(2)}`, role, provider: 'google', providerSubject: `s-${Math.random()}`, email: 'u@x.com', displayName: 'U', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role }) };
  }

  it('devolve a chamada REQUESTED destinada à modelo', async () => {
    const m = await user('MODEL');
    const c = await user('CLIENT');
    const call = await prisma.call.create({ data: { clientUserId: c.id, modelUserId: m.id, status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00') } });
    const res = await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.call?.id).toBe(call.id);
  });

  it('null quando não há chamada pendente', async () => {
    const m = await user('MODEL');
    const res = await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.call).toBeNull();
  });

  it('não conta chamada REQUESTED expirada', async () => {
    const m = await user('MODEL');
    const c = await user('CLIENT');
    await prisma.call.create({ data: { clientUserId: c.id, modelUserId: m.id, status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00'), requestedAt: new Date(Date.now() - 120000) } });
    const res = await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.call).toBeNull();
  });

  it('CLIENT → 403', async () => {
    const c = await user('CLIENT');
    await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${c.token}`).expect(403);
  });
});
