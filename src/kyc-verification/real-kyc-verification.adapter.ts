import { Injectable } from '@nestjs/common';
import type { KycSession, KycVerificationProvider } from './kyc-verification.port';

@Injectable()
export class RealKycVerificationProvider implements KycVerificationProvider {
  async createSession(_account: string): Promise<KycSession> {
    throw new Error('real KYC provider not configured');
  }
}
