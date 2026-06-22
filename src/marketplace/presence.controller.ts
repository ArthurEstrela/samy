import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PresenceService } from './presence.service';

@Controller('me/heartbeat')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Post()
  async beat(@Req() req: Request & { user: AuthUser }): Promise<{ status: 'ONLINE'; ttl: number }> {
    await this.presence.heartbeat(req.user.id);
    return { status: 'ONLINE', ttl: 30 };
  }
}
