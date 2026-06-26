import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

const TAXIMETER_INTERVAL_MS = 10_000;

@Injectable()
export class TaximeterService {
  private readonly logger = new Logger(TaximeterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  @Interval(TAXIMETER_INTERVAL_MS)
  async handleTick(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    await this.runDueCharges();
  }

  async runDueCharges(now: Date = new Date()): Promise<void> {
    const calls = await this.prisma.call.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, startedAt: true, billedMinutes: true },
    });
    for (const c of calls) {
      if (!c.startedAt) {
        continue;
      }
      const dueMinute = Math.floor((now.getTime() - c.startedAt.getTime()) / 60_000) + 1;
      for (let n = c.billedMinutes + 1; n <= dueMinute; n++) {
        try {
          const r = await this.billing.chargeMinute(c.id, n);
          if (r.ended) {
            break;
          }
        } catch (err) {
          this.logger.error(`taximeter charge failed for call ${c.id} minute ${n}`, err as Error);
          break;
        }
      }
    }
  }

  private isEnabled(): boolean {
    return process.env.SCHEDULERS_ENABLED === 'true';
  }
}
