import { Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UsersService } from '../users/users.service';
import { KycVerificationService } from './kyc-verification.service';

@Controller('kyc')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class KycVerificationController {
  constructor(
    private readonly kyc: KycVerificationService,
    private readonly users: UsersService,
  ) {}

  @Post('start')
  async start(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    const account = this.users.accountOf({ id: req.user.id, role: req.user.role });
    return this.kyc.start(account, req.user.id);
  }

  @Get('me')
  async me(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    const account = this.users.accountOf({ id: req.user.id, role: req.user.role });
    return this.kyc.getLatest(account);
  }

  @Post('dev-approve')
  async devApprove(@Req() req: Request & { user: AuthUser }): Promise<{ ok: true }> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const account = this.users.accountOf({ id: req.user.id, role: req.user.role });
    await this.kyc.devApprove(account, req.user.id);
    return { ok: true };
  }
}
