import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
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
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); });
  afterAll(async () => { await app.close(); });

  function sign(payload: object): { body: string; sig: string } {
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    return { body, sig };
  }

  it('credita o cliente em evento payment.confirmed assinado', async () => {
    const { body, sig } = sign({
      event: 'payment.confirmed',
      paymentId: 'pix_42',
      userId: '7',
      amount: '150.00',
    });
    await request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', sig)
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect((await ledger.getBalance('client:7')).toString()).toBe('150');
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
});
