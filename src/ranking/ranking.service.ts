import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Tier, TierRow, loadTierTable, tierForEarnings } from './ranking';

@Injectable()
export class RankingService {
  private readonly table: TierRow[];

  constructor(private readonly prisma: PrismaService) {
    const raw = process.env.GLOBAL_TAKE_RATE;
    if (!raw) throw new Error('GLOBAL_TAKE_RATE env var is required');
    this.table = loadTierTable(new Prisma.Decimal(raw));
  }

  async grossEarned(modelId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const client = tx ?? this.prisma;
    const r = await client.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { account: `model:${modelId}`, amount: { gt: 0 } },
    });
    return r._sum.amount ?? new Prisma.Decimal(0);
  }

  async tierRateFor(modelId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const earned = await this.grossEarned(modelId, tx);
    return tierForEarnings(earned, this.table).rate;
  }

  async myRanking(modelId: string): Promise<{
    tier: Tier; earned: string; takeRate: string;
    nextTier: Tier | null; nextThreshold: string | null; remaining: string | null;
  }> {
    const earned = await this.grossEarned(modelId);
    const info = tierForEarnings(earned, this.table);
    return {
      tier: info.tier,
      earned: earned.toFixed(2),
      takeRate: info.rate.toString(),
      nextTier: info.nextTier,
      nextThreshold: info.nextThreshold ? info.nextThreshold.toFixed(2) : null,
      remaining: info.remaining ? info.remaining.toFixed(2) : null,
    };
  }

  async top(limit: number): Promise<{ rank: number; modelId: string; stageName: string; tier: Tier }[]> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['account'],
      where: { account: { startsWith: 'model:' }, amount: { gt: 0 } },
      _sum: { amount: true },
    });
    const ranked = grouped
      .map((g) => ({ modelId: g.account.slice('model:'.length), earned: g._sum.amount ?? new Prisma.Decimal(0) }))
      .sort((a, b) => b.earned.comparedTo(a.earned))
      .slice(0, limit);
    if (ranked.length === 0) return [];
    const profiles = await this.prisma.modelProfile.findMany({
      where: { userId: { in: ranked.map((r) => r.modelId) } },
      select: { userId: true, stageName: true },
    });
    const nameOf = new Map(profiles.map((p) => [p.userId, p.stageName]));
    return ranked
      .filter((r) => nameOf.has(r.modelId))
      .map((r, i) => ({
        rank: i + 1,
        modelId: r.modelId,
        stageName: nameOf.get(r.modelId) as string,
        tier: tierForEarnings(r.earned, this.table).tier,
      }));
  }
}
