import { PrismaClient, Prisma } from '@prisma/client';

describe('billing schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => {
    await prisma.gift.deleteMany();
    await prisma.giftType.deleteMany();
    await prisma.modelProfile.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('ModelProfile aceita takeRate nulo e decimal', async () => {
    const a = await prisma.modelProfile.create({ data: { userId: 'u1', stageName: 'A', pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    expect(a.takeRate).toBeNull();
    const b = await prisma.modelProfile.create({ data: { userId: 'u2', stageName: 'B', pricePerMinute: new Prisma.Decimal('5.00'), tags: [], takeRate: new Prisma.Decimal('0.30') } });
    expect(b.takeRate?.toString()).toBe('0.3');
  });

  it('GiftType e Gift persistem', async () => {
    const gt = await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    expect(gt.active).toBe(true);
    const g = await prisma.gift.create({ data: { clientUserId: 'c1', modelUserId: 'm1', giftTypeId: gt.id, priceSnapshot: new Prisma.Decimal('10.00') } });
    expect(g.priceSnapshot.toString()).toBe('10');
  });
});
