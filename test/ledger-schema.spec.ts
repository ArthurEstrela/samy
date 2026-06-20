import { PrismaClient, Prisma } from '@prisma/client';

describe('ledger schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejeita idempotencyRef duplicado', async () => {
    const base = {
      account: 'client:1',
      entryType: 'RECARGA',
      amount: new Prisma.Decimal('100.00'),
      transactionGroup: 'g1',
      idempotencyRef: 'g1#0',
    };
    await prisma.ledgerEntry.create({ data: base });
    await expect(prisma.ledgerEntry.create({ data: base })).rejects.toMatchObject({ code: 'P2002' });
  });
});
