import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { KycVerificationService } from './kyc-verification.service';
import { KycSignatureValidator } from './kyc-signature.validator';

interface KycWebhookEvent {
  providerRef: string;
  outcome: 'APPROVED' | 'REJECTED';
  reason?: string;
}

@Controller('webhooks')
export class KycWebhookController {
  constructor(
    private readonly kyc: KycVerificationService,
    private readonly validator: KycSignatureValidator,
  ) {}

  @Post('kyc')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-kyc-signature') signature: string,
    @Body() event: KycWebhookEvent,
  ): Promise<{ received: boolean }> {
    const raw = req.rawBody;
    if (!raw || !signature || !this.validator.isValid(raw, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }
    // Corpo é autenticado por HMAC, mas ainda pode vir malformado do provedor:
    // valide a forma antes de tocar o banco (providerRef inválido viraria 500 no Prisma).
    if (event.outcome === 'APPROVED' || event.outcome === 'REJECTED') {
      if (typeof event.providerRef !== 'string' || event.providerRef.length === 0) {
        throw new BadRequestException('providerRef is required');
      }
      const reason = typeof event.reason === 'string' ? event.reason : undefined;
      await this.kyc.applyResult(event.providerRef, event.outcome, reason);
    }
    // outcome desconhecido (ex: eventos que não nos interessam) → 200 no-op.
    return { received: true };
  }
}
