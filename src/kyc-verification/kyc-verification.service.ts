import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KYC_VERIFICATION_PROVIDER } from './kyc-verification.port';
import type { KycVerificationProvider } from './kyc-verification.port';

interface StartResult {
  verificationId: string;
  clientToken: string;
  status: 'PENDING';
}

interface LatestResult {
  status: string;
  reason?: string;
  createdAt?: Date;
  resolvedAt?: Date;
}

@Injectable()
export class KycVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(KYC_VERIFICATION_PROVIDER) private readonly provider: KycVerificationProvider,
  ) {}

  async start(account: string, userId: string): Promise<StartResult> {
    const kyc = await this.prisma.kycStatus.findUnique({ where: { account } });
    if (kyc?.approved) {
      throw new ConflictException('KYC already approved');
    }
    const existing = await this.prisma.kycVerification.findFirst({
      where: { account, status: 'PENDING', sessionExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      return { verificationId: existing.id, clientToken: existing.clientToken, status: 'PENDING' };
    }
    const session = await this.provider.createSession(account);
    const created = await this.prisma.kycVerification.create({
      data: {
        account,
        userId,
        status: 'PENDING',
        providerRef: session.providerRef,
        clientToken: session.clientToken,
        sessionExpiresAt: session.expiresAt,
      },
    });
    return { verificationId: created.id, clientToken: created.clientToken, status: 'PENDING' };
  }

  async applyResult(
    providerRef: string,
    outcome: 'APPROVED' | 'REJECTED',
    reason?: string,
  ): Promise<void> {
    const v = await this.prisma.kycVerification.findUnique({ where: { providerRef } });
    if (!v || v.status !== 'PENDING') {
      return; // desconhecido ou já resolvido -> no-op idempotente
    }
    if (outcome === 'REJECTED') {
      await this.prisma.kycVerification.update({
        where: { providerRef },
        data: { status: 'REJECTED', resolvedAt: new Date(), reason: reason ?? null },
      });
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.kycVerification.update({
        where: { providerRef },
        data: { status: 'APPROVED', resolvedAt: new Date() },
      });
      await tx.kycStatus.upsert({
        where: { account: v.account },
        update: { approved: true },
        create: { account: v.account, approved: true },
      });
      // Promoção feita inline na transação (não via UsersService.setStatus) de propósito:
      // setStatus abre a própria conexão e quebraria a atomicidade com o kyc_status acima.
      const user = await tx.user.findUnique({ where: { id: v.userId } });
      if (user && user.status === 'PENDING_VERIFICATION') {
        await tx.user.update({ where: { id: v.userId }, data: { status: 'ACTIVE' } });
      }
    });
  }

  async devApprove(account: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.kycVerification.upsert({
        where: { providerRef: `dev:${account}` },
        update: { status: 'APPROVED', resolvedAt: now },
        create: {
          account,
          userId,
          status: 'APPROVED',
          providerRef: `dev:${account}`,
          clientToken: 'dev',
          sessionExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          resolvedAt: now,
        },
      });
      await tx.kycStatus.upsert({ where: { account }, update: { approved: true }, create: { account, approved: true } });
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (user && user.status === 'PENDING_VERIFICATION') {
        await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
      }
    });
  }

  async getLatest(account: string): Promise<LatestResult> {
    const v = await this.prisma.kycVerification.findFirst({
      where: { account },
      orderBy: { createdAt: 'desc' },
    });
    if (!v) {
      return { status: 'NONE' };
    }
    return {
      status: v.status,
      reason: v.reason ?? undefined,
      createdAt: v.createdAt,
      resolvedAt: v.resolvedAt ?? undefined,
    };
  }
}
