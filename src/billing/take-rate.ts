import { Prisma } from '@prisma/client';

export function resolveTakeRate(
  override: Prisma.Decimal | null,
  fallback: Prisma.Decimal,
): Prisma.Decimal {
  return override ?? fallback;
}

export function computeSplit(
  price: Prisma.Decimal,
  takeRate: Prisma.Decimal,
): { commission: Prisma.Decimal; modelShare: Prisma.Decimal } {
  const commission = price.mul(takeRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const modelShare = price.minus(commission);
  return { commission, modelShare };
}
