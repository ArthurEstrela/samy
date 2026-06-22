export const KYC_VERIFICATION_PROVIDER = 'KYC_VERIFICATION_PROVIDER';

export interface KycSession {
  providerRef: string;
  clientToken: string;
  expiresAt: Date;
}

export interface KycVerificationProvider {
  createSession(account: string): Promise<KycSession>;
}
