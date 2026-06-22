import { PrismaClient, Prisma } from '@prisma/client';

describe('calls schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => { await prisma.call.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('cria call REQUESTED com snapshot de preço', async () => {
    const c = await prisma.call.create({
      data: { clientUserId: 'c1', modelUserId: 'm1', status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00') },
    });
    expect(c.status).toBe('REQUESTED');
    expect(c.pricePerMinuteSnapshot.toString()).toBe('5');
    expect(c.startedAt).toBeNull();
    expect(c.endReason).toBeNull();
  });
});
