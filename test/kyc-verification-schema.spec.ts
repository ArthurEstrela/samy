import { PrismaClient } from '@prisma/client';

describe('kyc_verifications schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => { await prisma.kycVerification.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejeita providerRef duplicado', async () => {
    const base = {
      account: 'model:1',
      userId: 'u1',
      status: 'PENDING',
      providerRef: 'ref-1',
      clientToken: 'tok-1',
      sessionExpiresAt: new Date(Date.now() + 60000),
    };
    await prisma.kycVerification.create({ data: base });
    await expect(prisma.kycVerification.create({ data: { ...base, clientToken: 'tok-2' } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('reason e resolvedAt nascem nulos', async () => {
    const v = await prisma.kycVerification.create({
      data: { account: 'model:2', userId: 'u2', status: 'PENDING', providerRef: 'ref-2', clientToken: 'tok', sessionExpiresAt: new Date(Date.now() + 60000) },
    });
    expect(v.reason).toBeNull();
    expect(v.resolvedAt).toBeNull();
  });
});
