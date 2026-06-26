import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';

describe('POST /webhooks/psp', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  const secret = 'test-webhook-secret';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);
  });
  beforeEach(async () => { await prisma.recharge.deleteMany(); await prisma.ledgerEntry.deleteMany(); });
  afterAll(async () => { await app.close(); });

  function sign(payload: object): { body: string; sig: string } {
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    return { body, sig };
  }

  it('credita o cliente (create-first) em payment.confirmed assinado', async () => {
    await prisma.recharge.create({ data: { userId: '7', amount: new Prisma.Decimal('150.00'), status: 'PENDING', pspChargeId: 'pix_42' } });
    const { body, sig } = sign({ event: 'payment.confirmed', paymentId: 'pix_42', userId: '7', amount: '150.00' });
    await request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', sig)
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect((await ledger.getBalance('client:7')).toString()).toBe('150');
  });

  it('não credita sem Recharge correspondente (órfão), mas responde 200', async () => {
    await postSigned({ event: 'payment.confirmed', paymentId: 'pix_orphan', userId: '9', amount: '25.00' }).expect(200);
    expect((await ledger.getBalance('client:9')).toString()).toBe('0');
  });

  it('rejeita assinatura inválida com 401', async () => {
    const { body } = sign({ event: 'payment.confirmed', paymentId: 'x', userId: '7', amount: '1.00' });
    await request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', 'wrong')
      .set('content-type', 'application/json')
      .send(body)
      .expect(401);
  });

  function postSigned(payload: object): request.Test {
    const { body, sig } = sign(payload);
    return request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', sig)
      .set('content-type', 'application/json')
      .send(body);
  }

  it('rejeita com 400 quando paymentId está ausente (assinatura válida)', async () => {
    await postSigned({ event: 'payment.confirmed', userId: '7', amount: '10.00' }).expect(400);
    expect((await ledger.getBalance('client:7')).toString()).toBe('0');
  });

  it('rejeita com 400 quando userId está em branco', async () => {
    await postSigned({ event: 'payment.confirmed', paymentId: 'pix_1', userId: '', amount: '10.00' }).expect(400);
  });

  it('rejeita com 400 quando amount é não-positivo', async () => {
    await postSigned({ event: 'payment.confirmed', paymentId: 'pix_1', userId: '7', amount: '0' }).expect(400);
  });

  it('rejeita com 400 quando amount é malformado', async () => {
    await postSigned({ event: 'payment.confirmed', paymentId: 'pix_1', userId: '7', amount: 'abc' }).expect(400);
  });

  it('eventos não-payment.confirmed retornam 200 sem creditar', async () => {
    const res = await postSigned({ event: 'payment.pending', paymentId: 'pix_1', userId: '7', amount: '10.00' }).expect(200);
    expect(res.body).toEqual({ received: true });
  });
});
