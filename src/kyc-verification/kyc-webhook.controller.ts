import {
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
    if (event.outcome === 'APPROVED' || event.outcome === 'REJECTED') {
      await this.kyc.applyResult(event.providerRef, event.outcome, event.reason);
    }
    return { received: true };
  }
}
