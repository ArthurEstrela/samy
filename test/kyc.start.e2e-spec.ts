import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { KYC_VERIFICATION_PROVIDER } from '../src/kyc-verification/kyc-verification.port';
import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('KYC start/me', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;

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
  async function login(sub: string, role: string): Promise<string> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return res.body.accessToken;
  }

  it('MODEL inicia KYC → PENDING + clientToken', async () => {
    const token = await login('mod1', 'MODEL');
    const res = await http().post('/kyc/start').set('Authorization', `Bearer ${token}`).expect(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.clientToken).toBeTruthy();
  });

  it('CLIENT no /kyc/start → 403', async () => {
    const token = await login('cli1', 'CLIENT');
    await http().post('/kyc/start').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('sem token → 401', async () => {
    await http().post('/kyc/start').expect(401);
  });

  it('GET /kyc/me reflete a verificação atual; NONE quando nunca iniciou', async () => {
    const token = await login('mod2', 'MODEL');
    const none = await http().get('/kyc/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(none.body.status).toBe('NONE');
    await http().post('/kyc/start').set('Authorization', `Bearer ${token}`).expect(201);
    const pending = await http().get('/kyc/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(pending.body.status).toBe('PENDING');
  });
});
