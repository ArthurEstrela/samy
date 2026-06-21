import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';

interface AccessPayload {
  sub: string;
  role: string;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessSecret: string;
  private readonly refreshTtlMs: number;
  private readonly accessTtl: string;

  constructor(private readonly prisma: PrismaService) {
    const accessSecret = process.env.JWT_ACCESS_SECRET;
    if (!accessSecret) {
      throw new Error('JWT_ACCESS_SECRET env var is required');
    }
    if (!process.env.JWT_REFRESH_SECRET) {
      throw new Error('JWT_REFRESH_SECRET env var is required');
    }
    this.accessSecret = accessSecret;
    this.accessTtl = process.env.ACCESS_TTL ?? '15m';
    this.refreshTtlMs = this.parseDurationMs(process.env.REFRESH_TTL ?? '30d');
  }

  signAccess(user: { id: string; role: string }): string {
    return jwt.sign({ sub: user.id, role: user.role }, this.accessSecret, {
      expiresIn: this.accessTtl,
    } as jwt.SignOptions);
  }

  verifyAccess(token: string): AccessPayload {
    try {
      const decoded = jwt.verify(token, this.accessSecret) as AccessPayload;
      return { sub: decoded.sub, role: decoded.role };
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  async issueRefresh(userId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hash(raw),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
      },
    });
    return raw;
  }

  async rotateRefresh(rawToken: string): Promise<{ userId: string; refreshToken: string }> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
    });
    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.revokedAt) {
      // reuso de token revogado = sinal de roubo
      this.logger.error(`Refresh token reuse detected for user ${row.userId}; revoking all sessions`);
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'SECURITY_RESET' },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    await this.prisma.refreshToken.update({
      where: { tokenHash: row.tokenHash },
      data: { revokedAt: new Date(), revokedReason: 'ROTATED' },
    });
    const refreshToken = await this.issueRefresh(row.userId);
    return { userId: row.userId, refreshToken };
  }

  async revoke(rawToken: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private parseDurationMs(value: string): number {
    const match = /^(\d+)([smhd])$/.exec(value);
    if (!match) {
      throw new Error(`Invalid duration: ${value}`);
    }
    const n = Number(match[1]);
    const unit = match[2];
    const factor = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return n * factor;
  }
}
