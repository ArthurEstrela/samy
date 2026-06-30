import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { WalletService } from '../wallet/wallet.service';

const RECHARGE_SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class RechargeSweeper {
  private readonly logger = new Logger(RechargeSweeper.name);

  constructor(private readonly wallet: WalletService) {}

  @Interval(RECHARGE_SWEEP_INTERVAL_MS)
  async handleTick(): Promise<void> {
    if (process.env.SCHEDULERS_ENABLED !== 'true') return;
    try {
      const n = await this.wallet.expireStaleRecharges();
      if (n > 0) this.logger.log(`expirou ${n} recarga(s) vencida(s)`);
    } catch (err) {
      this.logger.error('recharge sweep tick failed', err as Error);
    }
  }
}
