import { Injectable } from '@nestjs/common';
import type { KycSession, KycVerificationProvider } from './kyc-verification.port';

@Injectable()
export class FakeKycVerificationProvider implements KycVerificationProvider {
  public calls: string[] = [];
  private seq = 0;

  reset(): void {
    this.calls = [];
    this.seq = 0;
  }

  async createSession(account: string): Promise<KycSession> {
    this.seq += 1;
    this.calls.push(account);
    return {
      providerRef: `ref-${account}-${this.seq}`,
      clientToken: `tok-${account}-${this.seq}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }
}
