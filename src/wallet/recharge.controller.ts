import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';

interface CreateRechargeDto {
  amount: string;
}

@Controller('wallet/recharge')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RechargeController {
  constructor(
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles('CLIENT')
  async create(@Req() req: Request & { user: AuthUser }, @Body() dto: CreateRechargeDto): Promise<unknown> {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(dto.amount);
    } catch {
      throw new BadRequestException('amount must be a valid decimal');
    }
    return this.wallet.createRecharge(req.user.id, amount);
  }

  @Get('history')
  @Roles('CLIENT')
  async history(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    const rows = await this.prisma.recharge.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      amount: r.amount.toString(),
      status: r.status,
      createdAt: r.createdAt,
      paidAt: r.paidAt,
    }));
  }

  @Get(':id')
  async get(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    const r = await this.prisma.recharge.findUnique({ where: { id } });
    if (!r || r.userId !== req.user.id) {
      throw new NotFoundException('recharge not found');
    }
    return { id: r.id, amount: r.amount.toString(), status: r.status, qrText: r.qrText, expiresAt: r.expiresAt, paidAt: r.paidAt };
  }

  @Post(':id/dev-confirm')
  async devConfirm(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const r = await this.prisma.recharge.findUnique({ where: { id } });
    if (!r || r.userId !== req.user.id) {
      throw new NotFoundException('recharge not found');
    }
    return this.wallet.confirmRecharge(r.pspChargeId ?? '', r.amount);
  }
}
