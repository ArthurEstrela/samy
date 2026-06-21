export const KYC_PORT = 'KYC_PORT';

export interface KycPort {
  isApproved(account: string): Promise<boolean>;
}
