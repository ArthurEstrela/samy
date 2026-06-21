import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UsersService } from '../users/users.service';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly users: UsersService) {}

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
