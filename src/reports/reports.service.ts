import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Report } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const REASONS = ['EXPLICITO', 'ENCONTRO_FORA', 'ASSEDIO', 'MENOR', 'GOLPE', 'OUTRO'];
const RESOLUTIONS = ['REVIEWED', 'DISMISSED'];

interface CreateReportDto { reportedUserId: string; callId?: string; reason: string; details?: string; }
export interface AdminReportView {
  id: string; reportedUserId: string; reportedName: string; reason: string;
  details: string | null; status: string; createdAt: Date;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(reporterId: string, dto: CreateReportDto): Promise<Report> {
    if (!dto.reportedUserId || dto.reportedUserId === reporterId) {
      throw new BadRequestException('invalid target');
    }
    if (!REASONS.includes(dto.reason)) {
      throw new BadRequestException('invalid reason');
    }
    const target = await this.prisma.user.findUnique({ where: { id: dto.reportedUserId } });
    if (!target) throw new NotFoundException('target not found');
    return this.prisma.report.create({
      data: {
        reporterUserId: reporterId,
        reportedUserId: dto.reportedUserId,
        callId: dto.callId,
        reason: dto.reason,
        details: dto.details,
      },
    });
  }

  async listOpen(status = 'OPEN'): Promise<AdminReportView[]> {
    const rows = await this.prisma.report.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const ids = [...new Set(rows.map((r) => r.reportedUserId))];
    const profiles = await this.prisma.modelProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, stageName: true } });
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
    const nameOf = new Map(profiles.map((p) => [p.userId, p.stageName]));
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({
      id: r.id,
      reportedUserId: r.reportedUserId,
      reportedName: nameOf.get(r.reportedUserId) ?? emailOf.get(r.reportedUserId) ?? r.reportedUserId,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async resolve(id: string, status: string): Promise<Report> {
    if (!RESOLUTIONS.includes(status)) throw new BadRequestException('invalid status');
    const existing = await this.prisma.report.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('report not found');
    return this.prisma.report.update({ where: { id }, data: { status, resolvedAt: new Date() } });
  }
}
