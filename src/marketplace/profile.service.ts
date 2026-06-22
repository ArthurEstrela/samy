import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ModelProfile, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertProfileDto } from './dto';

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(userId: string, dto: UpsertProfileDto): Promise<ModelProfile> {
    let price: Prisma.Decimal;
    try {
      price = new Prisma.Decimal(dto.pricePerMinute);
    } catch {
      throw new BadRequestException('pricePerMinute must be a decimal');
    }
    if (!price.greaterThan(0)) {
      throw new BadRequestException('pricePerMinute must be > 0');
    }
    if (dto.voicePreviewUrl !== undefined && !this.isHttpUrl(dto.voicePreviewUrl)) {
      throw new BadRequestException('voicePreviewUrl must be an http(s) URL');
    }
    const tags = dto.tags ?? [];
    return this.prisma.modelProfile.upsert({
      where: { userId },
      create: { userId, bio: dto.bio, pricePerMinute: price, tags, voicePreviewUrl: dto.voicePreviewUrl },
      update: { bio: dto.bio, pricePerMinute: price, tags, voicePreviewUrl: dto.voicePreviewUrl },
    });
  }

  async getOwn(userId: string): Promise<ModelProfile> {
    const p = await this.prisma.modelProfile.findUnique({ where: { userId } });
    if (!p) {
      throw new NotFoundException('Profile not found');
    }
    return p;
  }

  private isHttpUrl(value: string): boolean {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }
}
