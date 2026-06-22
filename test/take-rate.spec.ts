import { Prisma } from '@prisma/client';
import { resolveTakeRate, computeSplit } from '../src/billing/take-rate';

const D = (v: string): Prisma.Decimal => new Prisma.Decimal(v);

describe('take-rate', () => {
  it('resolveTakeRate usa override quando presente, senão o fallback', () => {
    expect(resolveTakeRate(D('0.30'), D('0.40')).toString()).toBe('0.3');
    expect(resolveTakeRate(null, D('0.40')).toString()).toBe('0.4');
  });

  it('computeSplit: preço inteiro divide certinho e soma zero', () => {
    const { commission, modelShare } = computeSplit(D('5.00'), D('0.40'));
    expect(commission.toString()).toBe('2');
    expect(modelShare.toString()).toBe('3');
    expect(commission.plus(modelShare).toString()).toBe('5');
  });

  it('computeSplit: preço ímpar arredonda a comissão e modelShare = preço − comissão (soma exata)', () => {
    const price = D('5.01');
    const { commission, modelShare } = computeSplit(price, D('0.40')); // 2.004 -> 2.00
    expect(commission.toString()).toBe('2');
    expect(modelShare.toString()).toBe('3.01');
    expect(commission.plus(modelShare).equals(price)).toBe(true);
  });
});
