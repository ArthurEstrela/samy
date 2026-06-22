import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Call, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import { MEDIA_SERVER } from './media-server.port';
import type { MediaServerProvider } from './media-server.port';

const RING_TIMEOUT_SECONDS = 30;

@Injectable()
export class CallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly redis: RedisService,
    @Inject(MEDIA_SERVER) private readonly media: MediaServerProvider,
  ) {}

  async initiate(clientId: string, modelId: string): Promise<Call> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, [`call-client:${clientId}`, `call-model:${modelId}`]);

      const clientOpen = await tx.call.findFirst({
        where: { clientUserId: clientId, status: { not: 'ENDED' } },
      });
      if (clientOpen) {
        throw new ConflictException('client already in a call');
      }

      const model = await tx.user.findUnique({ where: { id: modelId } });
      const profile = await tx.modelProfile.findUnique({ where: { userId: modelId } });
      if (!model || model.role !== 'MODEL' || model.status !== 'ACTIVE' || !profile) {
        throw new NotFoundException('model not available');
      }

      const modelOpen = await tx.call.findFirst({
        where: { modelUserId: modelId, status: { not: 'ENDED' } },
      });
      if (modelOpen) {
        throw new ConflictException('model busy');
      }

      if ((await this.redis.getStatus(modelId)) !== 'ONLINE') {
        throw new ConflictException('model offline');
      }

      const balance = await this.ledger.getBalance(`client:${clientId}`, tx);
      if (balance.lessThan(profile.pricePerMinute)) {
        throw new HttpException('insufficient balance', HttpStatus.PAYMENT_REQUIRED);
      }

      return tx.call.create({
        data: {
          clientUserId: clientId,
          modelUserId: modelId,
          status: 'REQUESTED',
          pricePerMinuteSnapshot: profile.pricePerMinute,
        },
      });
    });
  }

  private async lock(tx: Prisma.TransactionClient, keys: string[]): Promise<void> {
    for (const k of [...keys].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))`;
    }
  }

  private isExpired(requestedAt: Date): boolean {
    return Date.now() - requestedAt.getTime() > RING_TIMEOUT_SECONDS * 1000;
  }
}
