import { PrismaClient } from '@prisma/client';

describe('identity schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejeita (provider, providerSubject) duplicado', async () => {
    const base = {
      role: 'CLIENT',
      provider: 'google',
      providerSubject: 'sub-1',
      email: 'a@b.com',
      displayName: 'A',
      status: 'ACTIVE',
    };
    await prisma.user.create({ data: base });
    await expect(prisma.user.create({ data: { ...base, email: 'c@d.com' } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('persiste refresh token com revokedReason nulo por padrão', async () => {
    const user = await prisma.user.create({
      data: { role: 'CLIENT', provider: 'google', providerSubject: 's2', email: 'e@f.com', displayName: 'E', status: 'ACTIVE' },
    });
    const rt = await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: 'hash1', expiresAt: new Date(Date.now() + 1000) },
    });
    expect(rt.revokedReason).toBeNull();
    expect(rt.revokedAt).toBeNull();
  });
});
