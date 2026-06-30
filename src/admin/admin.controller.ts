import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UsersService } from '../users/users.service';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async list(@Query('role') role?: string, @Query('status') status?: string): Promise<unknown> {
    const users = await this.users.listUsers({ role, status });
    return users.map((u) => ({
      id: u.id, role: u.role, status: u.status, email: u.email, displayName: u.displayName, createdAt: u.createdAt,
    }));
  }

  @Post(':id/activate')
  async activate(@Param('id') id: string): Promise<{ id: string; status: string }> {
    const u = await this.users.setStatus(id, 'ACTIVE');
    return { id: u.id, status: u.status };
  }

  @Post(':id/suspend')
  async suspend(@Param('id') id: string): Promise<{ id: string; status: string }> {
    const u = await this.users.setStatus(id, 'SUSPENDED');
    return { id: u.id, status: u.status };
  }
}
