import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ReportsService } from './reports.service';

@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  async list(@Query('status') status?: string): Promise<unknown> {
    return this.reports.listOpen(status ?? 'OPEN');
  }

  @Post(':id/resolve')
  async resolve(@Param('id') id: string, @Body() body: { status: string }): Promise<unknown> {
    return this.reports.resolve(id, body.status);
  }
}
