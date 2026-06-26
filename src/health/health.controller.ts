import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check(): Promise<{ status: string; postgres: string; redis: string }> {
    const postgres = await this.checkPostgres();
    const redis = await this.checkRedis();
    if (postgres !== 'up' || redis !== 'up') {
      throw new ServiceUnavailableException({ status: 'error', postgres, redis });
    }
    return { status: 'ok', postgres, redis };
  }

  private async checkPostgres(): Promise<string> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<string> {
    try {
      return (await this.redis.ping()) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
