import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KycPort } from './kyc.port';

@Injectable()
export class TableKycAdapter implements KycPort {
  constructor(private readonly prisma: PrismaService) {}

  async isApproved(account: string): Promise<boolean> {
    const status = await this.prisma.kycStatus.findUnique({ where: { account } });
    return status?.approved ?? false;
  }
}
