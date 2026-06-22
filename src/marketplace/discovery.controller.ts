import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { DiscoveryService, ModelCard } from './discovery.service';

@Controller('models')
@UseGuards(JwtAuthGuard)
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get()
  async list(
    @Req() req: Request & { user: AuthUser },
    @Query('tags') tags?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ModelCard[]> {
    return this.discovery.list(
      {
        tags: tags ? tags.split(',').filter(Boolean) : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined,
      },
      { id: req.user.id, role: req.user.role },
    );
  }

  @Get(':id')
  async getOne(
    @Req() req: Request & { user: AuthUser },
    @Param('id') id: string,
  ): Promise<ModelCard> {
    return this.discovery.getOne(id, { id: req.user.id, role: req.user.role });
  }
}
