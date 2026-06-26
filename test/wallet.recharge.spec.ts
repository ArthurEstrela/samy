import { RealPspChargeAdapter } from '../src/wallet/real-psp-charge.adapter';
import { FakePspChargeAdapter } from '../src/wallet/fake-psp-charge.adapter';
import { LedgerService } from '../src/ledger/ledger.service';

describe('PSP charge adapters', () => {
  it('RealPspChargeAdapter lança "not configured" até plugar um provedor', async () => {
    const real = new RealPspChargeAdapter();
    await expect(
      real.createCharge({ rechargeId: 'r1', amount: '50.00', payerUserId: 'u1' }),
    ).rejects.toThrow(/not configured/i);
  });

  it('FakePspChargeAdapter devolve um QR determinístico com expiração futura', async () => {
    const fake = new FakePspChargeAdapter();
    const out = await fake.createCharge({ rechargeId: 'r1', amount: '50.00', payerUserId: 'u1' });
    expect(out.pspChargeId).toContain('r1');
    expect(typeof out.qrText).toBe('string');
    expect(out.qrText.length).toBeGreaterThan(0);
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

import { Test } from '@nestjs/testing';
import { INestApplication, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletService } from '../src/wallet/wallet.service';
import { TokenService } from '../src/auth/token.service';
import { PSP_CHARGE_PORT } from '../src/wallet/psp-charge.port';
import type { PspChargePort, PspChargeInput, PspCharge } from '../src/wallet/psp-charge.port';

@Injectable()
class ThrowingPspCharge implements PspChargePort {
  async createCharge(_i: PspChargeInput): Promise<PspCharge> {
    throw new Error('boom');
  }
}

describe('createRecharge + RechargeController', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wallet: WalletService;
  let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PSP_CHARGE_PORT)
      .useClass(FakePspChargeAdapter)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    wallet = mod.get(WalletService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.recharge.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function makeUser(role: 'CLIENT' | 'MODEL'): Promise<{ id: string; access: string }> {
    const u = await prisma.user.create({ data: { id: `u-${Math.random().toString(36).slice(2)}`, role, provider: 'google', providerSubject: `s-${Math.random()}`, email: `${Math.random()}@x.com`, displayName: 'U', status: 'ACTIVE' } });
    const access = tokens.signAccess({ id: u.id, role });
    return { id: u.id, access };
  }

  it('createRecharge persiste PENDING e devolve o QR (fake)', async () => {
    const { id } = await makeUser('CLIENT');
    const out = await wallet.createRecharge(id, new Prisma.Decimal('50.00'));
    expect(out.status).toBe('PENDING');
    expect(out.qrText).toContain(out.id);
    const row = await prisma.recharge.findUnique({ where: { id: out.id } });
    expect(row?.pspChargeId).toBe(`fake-charge:${out.id}`);
    expect(row?.expiresAt).not.toBeNull();
  });

  it('rejeita amount abaixo do mínimo com 400', async () => {
    const { id } = await makeUser('CLIENT');
    await expect(wallet.createRecharge(id, new Prisma.Decimal('1.00'))).rejects.toMatchObject({ status: 400 });
  });

  it('POST /wallet/recharge exige role CLIENT (403 para MODEL)', async () => {
    const { access } = await makeUser('MODEL');
    await request(app.getHttpServer())
      .post('/wallet/recharge')
      .set('authorization', `Bearer ${access}`)
      .send({ amount: '50.00' })
      .expect(403);
  });

  it('amount malformado → 400 (não 500)', async () => {
    const { access } = await makeUser('CLIENT');
    await request(app.getHttpServer())
      .post('/wallet/recharge')
      .set('authorization', `Bearer ${access}`)
      .send({ amount: 'abc' })
      .expect(400);
  });

  it('POST /wallet/recharge cria e GET /:id devolve ao dono; 404 para outro usuário', async () => {
    const client = await makeUser('CLIENT');
    const other = await makeUser('CLIENT');
    const res = await request(app.getHttpServer())
      .post('/wallet/recharge')
      .set('authorization', `Bearer ${client.access}`)
      .send({ amount: '50.00' })
      .expect(201);
    const id = res.body.id as string;
    await request(app.getHttpServer())
      .get(`/wallet/recharge/${id}`)
      .set('authorization', `Bearer ${client.access}`)
      .expect(200)
      .expect((r) => { expect(r.body.status).toBe('PENDING'); });
    await request(app.getHttpServer())
      .get(`/wallet/recharge/${id}`)
      .set('authorization', `Bearer ${other.access}`)
      .expect(404);
  });

  it('PSP indisponível marca a recarga FAILED e responde 503', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PSP_CHARGE_PORT)
      .useClass(ThrowingPspCharge)
      .compile();
    const app2 = mod.createNestApplication({ rawBody: true });
    await app2.init();
    const p2 = app2.get(PrismaService);
    const w2 = app2.get(WalletService);
    await p2.recharge.deleteMany();
    const u = await p2.user.create({ data: { id: `u-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: `${Math.random()}@x.com`, displayName: 'U', status: 'ACTIVE' } });
    await expect(w2.createRecharge(u.id, new Prisma.Decimal('50.00'))).rejects.toMatchObject({ status: 503 });
    const rows = await p2.recharge.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('FAILED');
    await app2.close();
  });
});

describe('confirmRecharge', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wallet: WalletService;
  let ledger: LedgerService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    wallet = mod.get(WalletService);
    ledger = mod.get(LedgerService);
  });
  beforeEach(async () => {
    await prisma.recharge.deleteMany();
    await prisma.ledgerEntry.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function pending(userId: string, amount: string, pspChargeId: string): Promise<string> {
    const r = await prisma.recharge.create({ data: { userId, amount: new Prisma.Decimal(amount), status: 'PENDING', pspChargeId } });
    return r.id;
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('credita o valor persistido e marca PAID; idempotente', async () => {
    const id = await pending('u1', '150.00', 'pix_42');
    const r1 = await wallet.confirmRecharge('pix_42', new Prisma.Decimal('150.00'));
    expect(r1.credited).toBe(true);
    expect(await bal('client:u1')).toBe('150');
    const row = await prisma.recharge.findUnique({ where: { id } });
    expect(row?.status).toBe('PAID');
    const r2 = await wallet.confirmRecharge('pix_42', new Prisma.Decimal('150.00'));
    expect(r2.credited).toBe(false);
    expect(r2.reason).toBe('already');
    expect(await bal('client:u1')).toBe('150');
  });

  it('paymentId desconhecido não credita', async () => {
    const r = await wallet.confirmRecharge('nope', new Prisma.Decimal('10.00'));
    expect(r.credited).toBe(false);
    expect(r.reason).toBe('unknown');
  });

  it('valor divergente não credita e mantém PENDING', async () => {
    const id = await pending('u2', '100.00', 'pix_77');
    const r = await wallet.confirmRecharge('pix_77', new Prisma.Decimal('999.00'));
    expect(r.credited).toBe(false);
    expect(r.reason).toBe('amount_mismatch');
    expect(await bal('client:u2')).toBe('0');
    const row = await prisma.recharge.findUnique({ where: { id } });
    expect(row?.status).toBe('PENDING');
  });
});
