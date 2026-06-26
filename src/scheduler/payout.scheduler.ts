import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PayoutProcessor } from '../payout/payout.processor';

const PAYOUT_INTERVAL_MS = 60_000;

@Injectable()
export class PayoutScheduler {
  private readonly logger = new Logger(PayoutScheduler.name);

  constructor(private readonly payoutProcessor: PayoutProcessor) {}

  @Interval(PAYOUT_INTERVAL_MS)
  async handleTick(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    try {
      await this.payoutProcessor.processPending();
    } catch (err) {
      this.logger.error('payout processing tick failed', err as Error);
    }
  }

  private isEnabled(): boolean {
    return process.env.SCHEDULERS_ENABLED === 'true';
  }
}
