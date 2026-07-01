import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';

interface CreateReportBody { reportedUserId: string; callId?: string; reason: string; details?: string; }

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  async create(@Req() req: Request & { user: AuthUser }, @Body() body: CreateReportBody): Promise<unknown> {
    return this.reports.create(req.user.id, body);
  }
}
