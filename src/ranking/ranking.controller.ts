import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { RankingService } from './ranking.service';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

@Controller('ranking')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RankingController {
  constructor(private readonly ranking: RankingService) {}

  @Get('me')
  @Roles('MODEL')
  async me(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    return this.ranking.myRanking(req.user.id);
  }

  @Get('top')
  async top(@Query('limit') limitRaw?: string): Promise<unknown> {
    const n = Number(limitRaw);
    const limit = Number.isFinite(n) && n >= 1 && n <= MAX_LIMIT ? Math.floor(n) : DEFAULT_LIMIT;
    return this.ranking.top(limit);
  }
}
