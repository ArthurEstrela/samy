import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { KYC_VERIFICATION_PROVIDER } from './kyc-verification.port';
import { RealKycVerificationProvider } from './real-kyc-verification.adapter';
import { KycVerificationService } from './kyc-verification.service';
import { KycVerificationController } from './kyc-verification.controller';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [KycVerificationController],
  providers: [
    KycVerificationService,
    { provide: KYC_VERIFICATION_PROVIDER, useClass: RealKycVerificationProvider },
  ],
  exports: [KycVerificationService],
})
export class KycVerificationModule {}
