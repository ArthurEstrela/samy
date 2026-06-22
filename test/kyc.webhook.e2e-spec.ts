import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { KYC_VERIFICATION_PROVIDER } from '../src/kyc-verification/kyc-verification.port';
import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('POST /webhooks/kyc', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;
  const secret = 'test-kyc-webhook-secret';

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .overrideProvider(KYC_VERIFICATION_PROVIDER).useClass(FakeKycVerificationProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.kycVerification.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  function sign(payload: object): { body: string; sig: string } {
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    return { body, sig };
  }
  async function startKyc(sub: string): Promise<string> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const reg = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role: 'MODEL' });
    await http().post('/kyc/start').set('Authorization', `Bearer ${reg.body.accessToken}`);
    const v = await prisma.kycVerification.findFirst({ where: { userId: reg.body.user.id } });
    return v!.providerRef;
  }

  it('APPROVED assinado libera a modelo (kyc_status true + ACTIVE)', async () => {
    const ref = await startKyc('mod1');
    const { body, sig } = sign({ providerRef: ref, outcome: 'APPROVED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(200);
    const u = await prisma.user.findFirst({ where: { providerSubject: 'mod1' } });
    expect(u?.status).toBe('ACTIVE');
    expect((await prisma.kycStatus.findUnique({ where: { account: `model:${u!.id}` } }))?.approved).toBe(true);
  });

  it('REJECTED grava reason; modelo não fica ACTIVE', async () => {
    const ref = await startKyc('mod2');
    const { body, sig } = sign({ providerRef: ref, outcome: 'REJECTED', reason: 'blur' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(200);
    const u = await prisma.user.findFirst({ where: { providerSubject: 'mod2' } });
    expect(u?.status).toBe('PENDING_VERIFICATION');
    const v = await prisma.kycVerification.findUnique({ where: { providerRef: ref } });
    expect(v?.status).toBe('REJECTED');
    expect(v?.reason).toBe('blur');
  });

  it('assinatura inválida → 401, nada muda', async () => {
    const ref = await startKyc('mod3');
    const { body } = sign({ providerRef: ref, outcome: 'APPROVED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', 'wrong').set('content-type', 'application/json').send(body).expect(401);
    const u = await prisma.user.findFirst({ where: { providerSubject: 'mod3' } });
    expect(u?.status).toBe('PENDING_VERIFICATION');
  });

  it('providerRef desconhecido → 200 e nada muda', async () => {
    const { body, sig } = sign({ providerRef: 'nope', outcome: 'APPROVED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(200);
  });

  it('payload assinado mas malformado (sem providerRef) → 400, não 500', async () => {
    const { body, sig } = sign({ outcome: 'APPROVED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(400);
  });

  it('outcome desconhecido → 200 no-op', async () => {
    const { body, sig } = sign({ providerRef: 'whatever', outcome: 'SESSION_STARTED' });
    await http().post('/webhooks/kyc').set('x-kyc-signature', sig).set('content-type', 'application/json').send(body).expect(200);
  });
});
