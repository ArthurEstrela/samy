export const IDENTITY_PROVIDER = 'IDENTITY_PROVIDER';

export interface IdentityClaims {
  provider: string;
  subject: string;
  email: string;
  name: string;
}

export interface IdentityProvider {
  verify(idToken: string): Promise<IdentityClaims>;
}
