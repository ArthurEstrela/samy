import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CallService } from './call.service';

interface InitiateDto {
  modelId: string;
}

@Controller('calls')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CallController {
  constructor(private readonly calls: CallService) {}

  @Post()
  @Roles('CLIENT')
  async initiate(@Req() req: Request & { user: AuthUser }, @Body() dto: InitiateDto): Promise<unknown> {
    return this.calls.initiate(req.user.id, dto.modelId);
  }

  @Post(':id/accept')
  @Roles('MODEL')
  async accept(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    return this.calls.accept(id, req.user.id);
  }

  @Post(':id/reject')
  @Roles('MODEL')
  async reject(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    return this.calls.reject(id, req.user.id);
  }
}
