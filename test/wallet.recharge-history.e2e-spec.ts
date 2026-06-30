import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /wallet/recharge/history', () => {
  let app: INestApplication; let prisma: PrismaService; let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService); tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.recharge.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function user(role: string): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { role, provider: 'google', providerSubject: `s-${Math.random()}`, email: 'x@y.com', displayName: 'X', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role }) };
  }
  async function recharge(userId: string, amount: string, status: string, pspChargeId: string): Promise<void> {
    await prisma.recharge.create({ data: { userId, amount: new Prisma.Decimal(amount), status, pspChargeId, qrText: 'qr-secret' } });
  }
  function http() { return request(app.getHttpServer()); }

  it('lista só as recargas do próprio cliente, desc, sem vazar qrText/pspChargeId', async () => {
    const a = await user('CLIENT');
    const b = await user('CLIENT');
    await recharge(a.id, '20.00', 'PAID', 'psp-a1');
    await new Promise((r) => setTimeout(r, 5));
    await recharge(a.id, '50.00', 'PENDING', 'psp-a2');
    await recharge(b.id, '99.00', 'PAID', 'psp-b1');

    const res = await http().get('/wallet/recharge/history').set('Authorization', `Bearer ${a.token}`).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].amount).toBe('50'); // mais recente primeiro
    expect(res.body[1].amount).toBe('20');
    expect(res.body[0]).toHaveProperty('status', 'PENDING');
    expect(res.body[0]).toHaveProperty('createdAt');
    expect(res.body[0]).not.toHaveProperty('qrText');
    expect(res.body[0]).not.toHaveProperty('pspChargeId');
  });

  it('MODEL → 403', async () => {
    const m = await user('MODEL');
    await http().get('/wallet/recharge/history').set('Authorization', `Bearer ${m.token}`).expect(403);
  });

  it('sem token → 401', async () => {
    await http().get('/wallet/recharge/history').expect(401);
  });
});
