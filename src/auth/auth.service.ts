import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from './token.service';
import { UsersService } from '../users/users.service';
import { IDENTITY_PROVIDER } from '../identity/identity.port';
import type { IdentityProvider } from '../identity/identity.port';

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; role: string; status: string; email: string; displayName: string };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
  ) {}

  async loginOrRegister(idToken: string, role?: string): Promise<AuthResult> {
    const claims = await this.identity.verify(idToken);
    let user = await this.users.findByProvider(claims.provider, claims.subject);
    if (!user) {
      if (role === 'ADMIN') {
        throw new BadRequestException('Cannot self-register as ADMIN');
      }
      const newRole = role === 'MODEL' ? 'MODEL' : 'CLIENT';
      user = await this.users.createUser({
        role: newRole,
        provider: claims.provider,
        subject: claims.subject,
        email: claims.email,
        name: claims.name,
      });
    }
    const refreshToken = await this.tokens.issueRefresh(user.id);
    return {
      accessToken: this.tokens.signAccess({ id: user.id, role: user.role }),
      refreshToken,
      user: {
        id: user.id,
        role: user.role,
        status: user.status,
        email: user.email,
        displayName: user.displayName,
      },
    };
  }

  async refresh(rawToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { userId, refreshToken } = await this.tokens.rotateRefresh(rawToken);
    const user = await this.users.findById(userId);
    if (!user || user.status === 'SUSPENDED') {
      await this.tokens.revoke(refreshToken, 'SECURITY_RESET');
      throw new UnauthorizedException('User not allowed');
    }
    return { accessToken: this.tokens.signAccess({ id: user.id, role: user.role }), refreshToken };
  }

  async logout(rawToken: string): Promise<void> {
    await this.tokens.revoke(rawToken, 'LOGOUT');
  }
}
