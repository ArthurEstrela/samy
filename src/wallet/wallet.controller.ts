import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { Prisma } from '@prisma/client';
import { WalletService } from './wallet.service';
import { PspSignatureValidator } from './psp-signature.validator';

interface PspEvent {
  event: string;
  paymentId: string;
  userId: string;
  amount: string;
}

@Controller('webhooks')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly validator: PspSignatureValidator,
  ) {}

  @Post('psp')
  @HttpCode(200)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async handle(
    @Req() req: any,
    @Headers('x-psp-signature') signature: string,
    @Body() event: PspEvent,
  ): Promise<{ received: boolean }> {
    const raw = (req as RawBodyRequest<Request>).rawBody;
    if (!raw || !signature || !this.validator.isValid(raw, signature)) {
      throw new UnauthorizedException('Invalid signature');
    }
    if (event.event === 'payment.confirmed') {
      await this.wallet.creditRecharge(
        event.paymentId,
        `client:${event.userId}`,
        new Prisma.Decimal(event.amount),
      );
    }
    return { received: true };
  }
}
