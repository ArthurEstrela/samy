import { Prisma } from '@prisma/client';
import { tierForEarnings, loadTierTable } from './ranking';

const D = (n: string | number): Prisma.Decimal => new Prisma.Decimal(n);
const TABLE = loadTierTable(D('0.30')); // global = 0.30 → BRONZE 0.30

describe('tierForEarnings (global 0.30)', () => {
  it('ganho 0 → BRONZE (= global), próximo PRATA a 500, faltam 500', () => {
    const r = tierForEarnings(D(0), TABLE);
    expect(r.tier).toBe('BRONZE');
    expect(r.rate.equals(D('0.30'))).toBe(true);
    expect(r.nextTier).toBe('PRATA');
    expect(r.nextThreshold?.equals(D(500))).toBe(true);
    expect(r.remaining?.equals(D(500))).toBe(true);
  });

  it('logo abaixo do limite continua no tier de baixo', () => {
    expect(tierForEarnings(D('499.99'), TABLE).tier).toBe('BRONZE');
  });

  it('exatamente no limite sobe de tier (PRATA = min(0.30,0.25) = 0.25)', () => {
    const r = tierForEarnings(D(500), TABLE);
    expect(r.tier).toBe('PRATA');
    expect(r.rate.equals(D('0.25'))).toBe(true);
  });

  it('OURO em 2000', () => {
    expect(tierForEarnings(D(2000), TABLE).tier).toBe('OURO');
  });

  it('DIAMANTE em 10000 é tier máximo (sem próximo)', () => {
    const r = tierForEarnings(D(10000), TABLE);
    expect(r.tier).toBe('DIAMANTE');
    expect(r.rate.equals(D('0.15'))).toBe(true);
    expect(r.nextTier).toBeNull();
    expect(r.nextThreshold).toBeNull();
    expect(r.remaining).toBeNull();
  });

  it('BRONZE herda a taxa global (global 0.40 → BRONZE 0.40)', () => {
    const t = loadTierTable(D('0.40'));
    expect(tierForEarnings(D(0), t).rate.equals(D('0.40'))).toBe(true);
    // tiers acima são capados por min(global, default): 0.25/0.20/0.15
    expect(tierForEarnings(D(500), t).rate.equals(D('0.25'))).toBe(true);
  });

  it('global menor que todos os defaults nunca aumenta a comissão', () => {
    const t = loadTierTable(D('0.10'));
    expect(tierForEarnings(D(0), t).rate.equals(D('0.10'))).toBe(true);
    expect(tierForEarnings(D(10000), t).rate.equals(D('0.10'))).toBe(true); // min(0.10,0.15)
  });

  it('env malformada → cai nos defaults', () => {
    const table = loadTierTable(D('0.30'), { RANKING_THRESHOLDS: 'xyz' } as NodeJS.ProcessEnv);
    expect(table[0].rate.equals(D('0.30'))).toBe(true);
    expect(table).toHaveLength(4);
  });
});
