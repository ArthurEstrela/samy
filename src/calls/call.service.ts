import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Call, Prisma } from '@prisma/client';
import type { MediaToken } from './media-server.port';
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

  async accept(callId: string, modelId: string): Promise<{ call: Call; media: MediaToken }> {
    type TxResult =
      | { outcome: 'active'; call: Call }
      | { outcome: 'no_credits'; clientUserId: string }
      | { outcome: 'timeout'; clientUserId: string }
      | { outcome: 'not_found' }
      | { outcome: 'forbidden' }
      | { outcome: 'conflict'; reason: string };

    const txResult = await this.prisma.$transaction(async (tx): Promise<TxResult> => {
      const found = await tx.call.findUnique({ where: { id: callId } });
      if (!found) return { outcome: 'not_found' };
      if (found.modelUserId !== modelId) return { outcome: 'forbidden' };
      await this.lock(tx, [`call-client:${found.clientUserId}`]);
      const call = await tx.call.findUnique({ where: { id: callId } });
      if (!call) return { outcome: 'not_found' };
      if (call.status === 'REQUESTED' && this.isExpired(call.requestedAt)) {
        return { outcome: 'timeout', clientUserId: call.clientUserId };
      }
      if (call.status !== 'REQUESTED') {
        return { outcome: 'conflict', reason: 'call not pending' };
      }
      const otherActive = await tx.call.findFirst({
        where: { clientUserId: call.clientUserId, status: 'ACTIVE', id: { not: callId } },
      });
      if (otherActive) {
        return { outcome: 'conflict', reason: 'client already in a call' };
      }
      const balance = await this.ledger.getBalance(`client:${call.clientUserId}`, tx);
      if (balance.lessThan(call.pricePerMinuteSnapshot)) {
        return { outcome: 'no_credits', clientUserId: call.clientUserId };
      }
      const roomName = `call:${callId}`;
      const active = await tx.call.update({
        where: { id: callId },
        data: { status: 'ACTIVE', startedAt: new Date(), roomName },
      });
      return { outcome: 'active', call: active };
    });

    // Handle outcomes that require writes outside the tx (so they are not rolled back)
    if (txResult.outcome === 'not_found') {
      throw new NotFoundException('call not found');
    }
    if (txResult.outcome === 'forbidden') {
      throw new ForbiddenException('not your call');
    }
    if (txResult.outcome === 'timeout') {
      // CAS guard (status REQUESTED) so a concurrent hangup isn't clobbered
      await this.prisma.call.updateMany({ where: { id: callId, status: 'REQUESTED' }, data: { status: 'ENDED', endReason: 'TIMEOUT', endedAt: new Date() } });
      throw new ConflictException('call expired');
    }
    if (txResult.outcome === 'conflict') {
      throw new ConflictException(txResult.reason);
    }
    if (txResult.outcome === 'no_credits') {
      // CAS guard (status REQUESTED) so a concurrent hangup isn't clobbered
      await this.prisma.call.updateMany({ where: { id: callId, status: 'REQUESTED' }, data: { status: 'ENDED', endReason: 'NO_CREDITS', endedAt: new Date() } });
      throw new HttpException('insufficient balance', HttpStatus.PAYMENT_REQUIRED);
    }

    // outcome === 'active'
    const media = await this.media.issueToken(txResult.call.roomName as string, `model:${modelId}`);
    return { call: txResult.call, media };
  }

  async reject(callId: string, modelId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.modelUserId !== modelId) {
      throw new ForbiddenException('not your call');
    }
    const res = await this.prisma.call.updateMany({
      where: { id: callId, status: 'REQUESTED' },
      data: { status: 'ENDED', endReason: 'REJECTED', endedAt: new Date() },
    });
    if (res.count === 0) {
      throw new ConflictException('call not pending');
    }
    return this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }

  async hangup(callId: string, userId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.clientUserId !== userId && call.modelUserId !== userId) {
      throw new ForbiddenException('not a participant');
    }
    if (call.status === 'ENDED') {
      return call; // idempotente
    }
    const reason = call.clientUserId === userId ? 'HANGUP_CLIENT' : 'HANGUP_MODEL';
    await this.prisma.call.updateMany({
      where: { id: callId, status: { not: 'ENDED' } },
      data: { status: 'ENDED', endReason: reason, endedAt: new Date() },
    });
    return this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }

  async panic(callId: string, modelId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.modelUserId !== modelId) {
      throw new ForbiddenException('not a participant');
    }
    await this.prisma.call.updateMany({
      where: { id: callId, status: { not: 'ENDED' } },
      data: { status: 'ENDED', endReason: 'PANIC', endedAt: new Date() },
    });
    return this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }

  async endCall(callId: string, reason: string): Promise<void> {
    await this.prisma.call.updateMany({
      where: { id: callId, status: { not: 'ENDED' } },
      data: { status: 'ENDED', endReason: reason, endedAt: new Date() },
    });
  }

  async activeModelIds(modelIds: string[]): Promise<Set<string>> {
    if (modelIds.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.call.findMany({
      where: { modelUserId: { in: modelIds }, status: 'ACTIVE' },
      select: { modelUserId: true },
    });
    return new Set(rows.map((r) => r.modelUserId));
  }

  async getForParticipant(
    callId: string,
    userId: string,
    role: string,
  ): Promise<{ call: Call; media?: MediaToken }> {
    let call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.clientUserId !== userId && call.modelUserId !== userId) {
      throw new ForbiddenException('not a participant');
    }
    if (call.status === 'REQUESTED' && this.isExpired(call.requestedAt)) {
      await this.prisma.call.updateMany({
        where: { id: callId, status: 'REQUESTED' },
        data: { status: 'ENDED', endReason: 'TIMEOUT', endedAt: new Date() },
      });
      call = await this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
    }
    if (call.status === 'ACTIVE' && call.roomName) {
      const identity = role === 'MODEL' ? `model:${userId}` : `client:${userId}`;
      const media = await this.media.issueToken(call.roomName, identity);
      return { call, media };
    }
    return { call };
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
