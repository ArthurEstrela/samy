import { Module } from '@nestjs/common';
import { IDENTITY_PROVIDER } from './identity.port';
import { GoogleIdentityProvider } from './google-identity.adapter';

@Module({
  providers: [{ provide: IDENTITY_PROVIDER, useClass: GoogleIdentityProvider }],
  exports: [IDENTITY_PROVIDER],
})
export class IdentityModule {}
