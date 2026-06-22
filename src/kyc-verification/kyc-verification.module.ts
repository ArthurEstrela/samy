import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { KYC_VERIFICATION_PROVIDER } from './kyc-verification.port';
import { RealKycVerificationProvider } from './real-kyc-verification.adapter';
import { KycVerificationService } from './kyc-verification.service';
import { KycVerificationController } from './kyc-verification.controller';
import { KycWebhookController } from './kyc-webhook.controller';
import { KycSignatureValidator } from './kyc-signature.validator';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [KycVerificationController, KycWebhookController],
  providers: [
    KycVerificationService,
    { provide: KYC_VERIFICATION_PROVIDER, useClass: RealKycVerificationProvider },
    {
      provide: KycSignatureValidator,
      useFactory: (): KycSignatureValidator => {
        const secret = process.env.KYC_WEBHOOK_SECRET;
        if (!secret) {
          throw new Error('KYC_WEBHOOK_SECRET env var is required');
        }
        return new KycSignatureValidator(secret);
      },
    },
  ],
  exports: [KycVerificationService],
})
export class KycVerificationModule {}
