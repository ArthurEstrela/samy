import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from './presence.service';
import { FavoritesService } from './favorites.service';
import { CallService } from '../calls/call.service';

const MAX_CANDIDATES = 5000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

type CallStatus = 'ONLINE' | 'OCUPADA' | 'OFFLINE';
const STATUS_RANK: Record<CallStatus, number> = { ONLINE: 0, OCUPADA: 1, OFFLINE: 2 };

export interface ModelCard {
  userId: string;
  stageName: string;
  bio: string | null;
  pricePerMinute: string;
  tags: string[];
  voicePreviewUrl: string | null;
  status: CallStatus;
  isFavorite: boolean;
}

interface Requester {
  id: string;
  role: string;
}

interface ListParams {
  tags?: string[];
  limit?: number;
  offset?: number;
}

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly favorites: FavoritesService,
    private readonly callService: CallService,
  ) {}

  async list(params: ListParams, requester: Requester): Promise<ModelCard[]> {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const offset = params.offset ?? 0;
    if (
      !Number.isFinite(limit) ||
      !Number.isFinite(offset) ||
      limit < 1 ||
      limit > MAX_LIMIT ||
      offset < 0
    ) {
      throw new BadRequestException('invalid limit/offset');
    }

    const activeUsers = await this.prisma.user.findMany({
      where: { role: 'MODEL', status: 'ACTIVE' },
      select: { id: true },
    });
    const activeIds = activeUsers.map((u) => u.id);

    const profiles = await this.prisma.modelProfile.findMany({
      where: {
        userId: { in: activeIds },
        ...(params.tags && params.tags.length > 0 ? { tags: { hasEvery: params.tags } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATES,
    });
    const candidates = profiles;

    const candidateIds = candidates.map((p) => p.userId);
    const presence = await this.presence.getStatuses(candidateIds);
    const busy = await this.callService.activeModelIds(candidateIds);
    const favoriteIds =
      requester.role === 'CLIENT'
        ? new Set(await this.favorites.listFavoriteModelIds(requester.id))
        : new Set<string>();

    const statusOf = (id: string): CallStatus =>
      busy.has(id) ? 'OCUPADA' : presence[id] === 'ONLINE' ? 'ONLINE' : 'OFFLINE';

    const cards = candidates.map((p) =>
      this.toCard(p, statusOf(p.userId), favoriteIds.has(p.userId)),
    );

    cards.sort((a, b) => {
      if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
        return STATUS_RANK[a.status] - STATUS_RANK[b.status];
      }
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      return 0; // candidates já vêm por createdAt desc; sort estável preserva
    });

    return cards.slice(offset, offset + limit);
  }

  async getOne(modelId: string, requester: Requester): Promise<ModelCard> {
    const profile = await this.prisma.modelProfile.findUnique({ where: { userId: modelId } });
    const user = await this.prisma.user.findUnique({ where: { id: modelId } });
    if (!profile || !user || user.role !== 'MODEL' || user.status !== 'ACTIVE') {
      throw new NotFoundException('Model not found');
    }
    const busy = await this.callService.activeModelIds([modelId]);
    const status: CallStatus = busy.has(modelId)
      ? 'OCUPADA'
      : (await this.presence.getStatus(modelId)) === 'ONLINE'
        ? 'ONLINE'
        : 'OFFLINE';
    const isFavorite =
      requester.role === 'CLIENT'
        ? new Set(await this.favorites.listFavoriteModelIds(requester.id)).has(modelId)
        : false;
    return this.toCard(profile, status, isFavorite);
  }

  private toCard(
    p: { userId: string; stageName: string; bio: string | null; pricePerMinute: { toString(): string }; tags: string[]; voicePreviewUrl: string | null },
    status: CallStatus,
    isFavorite: boolean,
  ): ModelCard {
    return {
      userId: p.userId,
      stageName: p.stageName,
      bio: p.bio,
      pricePerMinute: p.pricePerMinute.toString(),
      tags: p.tags,
      voicePreviewUrl: p.voicePreviewUrl,
      status,
      isFavorite,
    };
  }
}
