import { Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { FavoritesService } from './favorites.service';

@Controller('favorites')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Post(':modelId')
  async add(@Req() req: Request & { user: AuthUser }, @Param('modelId') modelId: string): Promise<{ ok: true }> {
    await this.favorites.favorite(req.user.id, modelId);
    return { ok: true };
  }

  @Delete(':modelId')
  @HttpCode(200)
  async remove(@Req() req: Request & { user: AuthUser }, @Param('modelId') modelId: string): Promise<{ ok: true }> {
    await this.favorites.unfavorite(req.user.id, modelId);
    return { ok: true };
  }

  @Get()
  async list(@Req() req: Request & { user: AuthUser }): Promise<string[]> {
    return this.favorites.listFavoriteModelIds(req.user.id);
  }
}
