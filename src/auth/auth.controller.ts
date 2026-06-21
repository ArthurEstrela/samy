import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { GoogleLoginDto, RefreshDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('google')
  async google(@Body() body: GoogleLoginDto): Promise<unknown> {
    if (!body?.idToken || typeof body.idToken !== 'string') {
      throw new BadRequestException('idToken is required');
    }
    return this.auth.loginOrRegister(body.idToken, body.role);
  }

  @Post('refresh')
  async refresh(@Body() body: RefreshDto): Promise<unknown> {
    if (!body?.refreshToken || typeof body.refreshToken !== 'string') {
      throw new BadRequestException('refreshToken is required');
    }
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  async logout(@Body() body: RefreshDto): Promise<{ ok: true }> {
    if (body?.refreshToken && typeof body.refreshToken === 'string') {
      await this.auth.logout(body.refreshToken);
    }
    return { ok: true };
  }
}
