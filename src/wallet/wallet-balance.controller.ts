import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LedgerService } from '../ledger/ledger.service';

@Controller('wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WalletBalanceController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('balance')
  @Roles('CLIENT')
  async balance(@Req() req: Request & { user: AuthUser }): Promise<{ balance: string }> {
    const b = await this.ledger.getBalance(`client:${req.user.id}`);
    return { balance: b.toString() };
  }

  @Get('earnings')
  @Roles('MODEL')
  async earnings(@Req() req: Request & { user: AuthUser }): Promise<{ balance: string }> {
    const b = await this.ledger.getBalance(`model:${req.user.id}`);
    return { balance: b.toString() };
  }
}
