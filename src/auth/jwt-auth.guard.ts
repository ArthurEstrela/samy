import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { TokenService } from './token.service';
import { UsersService } from '../users/users.service';

export interface AuthUser {
  id: string;
  role: string;
  status: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const payload = this.tokens.verifyAccess(header.slice('Bearer '.length));
    const user = await this.users.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    if (user.status === 'SUSPENDED') {
      throw new ForbiddenException('User suspended');
    }
    req.user = { id: user.id, role: user.role, status: user.status };
    return true;
  }
}
