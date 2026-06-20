import { PrismaClient } from '@prisma/client';

describe('infra smoke', () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });

  it('conecta no Postgres de teste e executa uma query', async () => {
    const result = await prisma.$queryRaw`SELECT 1 as ok`;
    expect(result).toEqual([{ ok: 1 }]);
  });
});
