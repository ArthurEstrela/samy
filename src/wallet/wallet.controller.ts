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
import { Prisma } from '@prisma/client';
import { WalletService } from './wallet.service';
import { PspSignatureValidator } from './psp-signature.validator';

interface PspEvent {
  event: string;
  paymentId: string;
  userId: string;
  amount: string;
}

// Positive decimal with up to 2 fractional digits, e.g. "150" or "150.00".
const POSITIVE_DECIMAL = /^\d+(\.\d{1,2})?$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

@Controller('webhooks')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly validator: PspSignatureValidator,
  ) {}

  @Post('psp')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-psp-signature') signature: string,
    @Body() event: PspEvent,
  ): Promise<{ received: boolean }> {
    const raw = req.rawBody;
    if (!raw || !signature || !this.validator.isValid(raw, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }

    // Non-payment.confirmed events are acknowledged without crediting.
    if (event?.event !== 'payment.confirmed') {
      return { received: true };
    }

    // Validate the payload AFTER the HMAC check passes, BEFORE crediting.
    if (!isNonEmptyString(event.paymentId)) {
      throw new BadRequestException('paymentId is required');
    }
    if (!isNonEmptyString(event.userId)) {
      throw new BadRequestException('userId is required');
    }
    if (
      typeof event.amount !== 'string' ||
      !POSITIVE_DECIMAL.test(event.amount) ||
      !new Prisma.Decimal(event.amount).greaterThan(new Prisma.Decimal(0))
    ) {
      throw new BadRequestException('amount must be a positive decimal');
    }

    await this.wallet.confirmRecharge(event.paymentId, new Prisma.Decimal(event.amount));
    return { received: true };
  }
}
