import { Prisma } from '@prisma/client';

export type Tier = 'BRONZE' | 'PRATA' | 'OURO' | 'DIAMANTE';

export interface TierRow {
  tier: Tier;
  min: Prisma.Decimal;
  rate: Prisma.Decimal;
}

export interface TierInfo {
  tier: Tier;
  rate: Prisma.Decimal;
  nextTier: Tier | null;
  nextThreshold: Prisma.Decimal | null;
  remaining: Prisma.Decimal | null;
}

const TIER_ORDER: Tier[] = ['BRONZE', 'PRATA', 'OURO', 'DIAMANTE'];
const DEFAULT_THRESHOLDS = [0, 500, 2000, 10000];
// Taxas-alvo dos tiers acima de BRONZE; BRONZE herda o globalRate.
const DEFAULT_RATES = ['0.30', '0.25', '0.20', '0.15'];

function parseList(raw: string | undefined, expected: number): string[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== expected || parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  return parts;
}

export function loadTierTable(globalRate: Prisma.Decimal, env: NodeJS.ProcessEnv = process.env): TierRow[] {
  const thresholds = parseList(env.RANKING_THRESHOLDS, 4);
  const rates = parseList(env.RANKING_RATES, 4);
  if ((env.RANKING_THRESHOLDS && !thresholds) || (env.RANKING_RATES && !rates)) {
    // eslint-disable-next-line no-console
    console.warn('RANKING_THRESHOLDS/RANKING_RATES malformado — usando defaults.');
  }
  const th = thresholds ?? DEFAULT_THRESHOLDS.map(String);
  const rt = rates ?? DEFAULT_RATES;
  return TIER_ORDER.map((tier, i) => {
    // BRONZE (i=0) usa o globalRate; demais usam a taxa-alvo, sempre capada por
    // min(global, alvo) pra subir de tier nunca aumentar a comissão.
    const target = i === 0 ? globalRate : new Prisma.Decimal(rt[i]);
    const rate = Prisma.Decimal.min(globalRate, target);
    return { tier, min: new Prisma.Decimal(th[i]), rate };
  });
}

export function tierForEarnings(earned: Prisma.Decimal, table: TierRow[]): TierInfo {
  let idx = 0;
  for (let i = 0; i < table.length; i++) {
    if (earned.gte(table[i].min)) idx = i;
  }
  const row = table[idx];
  const next = idx + 1 < table.length ? table[idx + 1] : null;
  return {
    tier: row.tier,
    rate: row.rate,
    nextTier: next ? next.tier : null,
    nextThreshold: next ? next.min : null,
    remaining: next ? next.min.minus(earned) : null,
  };
}
