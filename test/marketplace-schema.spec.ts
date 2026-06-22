import { PrismaClient, Prisma } from '@prisma/client';

describe('marketplace schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => {
    await prisma.favorite.deleteMany();
    await prisma.modelProfile.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('cria perfil com tags (text[]) e preço decimal', async () => {
    const p = await prisma.modelProfile.create({
      data: { userId: 'u1', stageName: 'Luna', pricePerMinute: new Prisma.Decimal('5.00'), tags: ['voz-suave', 'noturno'] },
    });
    expect(p.tags).toEqual(['voz-suave', 'noturno']);
    expect(p.pricePerMinute.toString()).toBe('5');
  });

  it('rejeita favorito duplicado (mesmo cliente+modelo)', async () => {
    const base = { clientUserId: 'c1', modelUserId: 'm1' };
    await prisma.favorite.create({ data: base });
    await expect(prisma.favorite.create({ data: base })).rejects.toMatchObject({ code: 'P2002' });
  });
});
