import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BillingService } from './billing.service';

interface SendGiftDto {
  modelId: string;
  giftTypeId: string;
}

@Controller('gifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GiftsController {
  constructor(private readonly billing: BillingService) {}

  @Get('catalog')
  async catalog(): Promise<unknown> {
    return this.billing.listGiftCatalog();
  }

  @Post()
  @Roles('CLIENT')
  async send(@Req() req: Request & { user: AuthUser }, @Body() dto: SendGiftDto): Promise<unknown> {
    return this.billing.sendGift(req.user.id, dto.modelId, dto.giftTypeId);
  }
}
