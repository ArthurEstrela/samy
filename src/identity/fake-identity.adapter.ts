import { Injectable, UnauthorizedException } from '@nestjs/common';
import { IdentityClaims, IdentityProvider } from './identity.port';

@Injectable()
export class FakeIdentityProvider implements IdentityProvider {
  private readonly tokens = new Map<string, IdentityClaims>();

  register(idToken: string, claims: IdentityClaims): void {
    this.tokens.set(idToken, claims);
  }

  reset(): void {
    this.tokens.clear();
  }

  async verify(idToken: string): Promise<IdentityClaims> {
    const claims = this.tokens.get(idToken);
    if (!claims) {
      throw new UnauthorizedException('Invalid identity token');
    }
    return claims;
  }
}
