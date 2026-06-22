import { Body, Controller, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ProfileService } from './profile.service';
import type { UpsertProfileDto } from './dto';

@Controller('me/profile')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Put()
  @HttpCode(200)
  async upsert(
    @Req() req: Request & { user: AuthUser },
    @Body() dto: UpsertProfileDto,
  ): Promise<unknown> {
    return this.profiles.upsert(req.user.id, dto);
  }

  @Get()
  async get(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    return this.profiles.getOwn(req.user.id);
  }
}
