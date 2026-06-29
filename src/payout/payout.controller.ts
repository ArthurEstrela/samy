import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PayoutService } from './payout.service';

interface RequestPayoutDto {
  amount: string;
  pixKey: string;
}

@Controller('payouts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class PayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Post()
  async request(@Req() req: Request & { user: AuthUser }, @Body() dto: RequestPayoutDto): Promise<unknown> {
    if (!dto?.pixKey || typeof dto.pixKey !== 'string') {
      throw new BadRequestException('pixKey is required');
    }
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(dto.amount);
    } catch {
      throw new BadRequestException('amount must be a valid decimal');
    }
    return this.payouts.requestPayout(`model:${req.user.id}`, amount, dto.pixKey);
  }

  @Get()
  async list(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    return this.payouts.listForAccount(`model:${req.user.id}`);
  }

  @Post('dev-grant')
  async devGrant(@Req() req: Request & { user: AuthUser }): Promise<{ ok: true }> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    await this.payouts.grantDevEarnings(`model:${req.user.id}`);
    return { ok: true };
  }
}
