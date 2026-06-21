export const PSP_PAYOUT_PORT = 'PSP_PAYOUT_PORT';

export interface PspPayoutPort {
  sendPix(pixKey: string, amount: string, idempotencyKey: string): Promise<void>;
}
