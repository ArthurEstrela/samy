export const PSP_CHARGE_PORT = 'PSP_CHARGE_PORT';

export interface PspChargeInput {
  rechargeId: string;
  amount: string;
  payerUserId: string;
}

export interface PspCharge {
  pspChargeId: string;
  qrText: string;
  expiresAt: Date;
}

export interface PspChargePort {
  createCharge(input: PspChargeInput): Promise<PspCharge>;
}
