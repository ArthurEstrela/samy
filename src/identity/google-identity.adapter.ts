import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import type { IdentityClaims, IdentityProvider } from './identity.port';

@Injectable()
export class GoogleIdentityProvider implements IdentityProvider {
  private readonly client: OAuth2Client;
  private readonly clientId: string;

  constructor() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID env var is required');
    }
    this.clientId = clientId;
    this.client = new OAuth2Client(clientId);
  }

  async verify(idToken: string): Promise<IdentityClaims> {
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) {
        throw new UnauthorizedException('Invalid Google token payload');
      }
      return {
        provider: 'google',
        subject: payload.sub,
        email: payload.email,
        name: payload.name ?? payload.email,
      };
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        throw e;
      }
      throw new UnauthorizedException('Invalid Google token');
    }
  }
}
