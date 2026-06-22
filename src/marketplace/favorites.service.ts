import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async favorite(clientId: string, modelId: string): Promise<void> {
    const model = await this.prisma.user.findUnique({ where: { id: modelId } });
    if (!model || model.role !== 'MODEL') {
      throw new NotFoundException('Model not found');
    }
    await this.prisma.favorite.upsert({
      where: { clientUserId_modelUserId: { clientUserId: clientId, modelUserId: modelId } },
      create: { clientUserId: clientId, modelUserId: modelId },
      update: {},
    });
  }

  async unfavorite(clientId: string, modelId: string): Promise<void> {
    await this.prisma.favorite.deleteMany({
      where: { clientUserId: clientId, modelUserId: modelId },
    });
  }

  async listFavoriteModelIds(clientId: string): Promise<string[]> {
    const rows = await this.prisma.favorite.findMany({
      where: { clientUserId: clientId },
      select: { modelUserId: true },
    });
    return rows.map((r) => r.modelUserId);
  }
}
