import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { WalletModule } from '../src/wallet/wallet.module';
import { WalletService } from '../src/wallet/wallet.service';

describe('WalletService.creditRecharge', () => {
  let wallet: WalletService;
  let ledger: LedgerService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, WalletModule],
    }).compile();
    wallet = moduleRef.get(WalletService);
    ledger = moduleRef.get(LedgerService);
    prisma = moduleRef.get(PrismaService);
  });
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('credita o cliente e mantém o sistema em soma zero', async () => {
    await wallet.creditRecharge('pix_1', 'client:1', new Prisma.Decimal('100.00'));
    expect((await ledger.getBalance('client:1')).toString()).toBe('100');
    expect((await ledger.getBalance('source:external')).toString()).toBe('-100');
  });

  it('webhook duplicado não credita duas vezes', async () => {
    await wallet.creditRecharge('pix_1', 'client:1', new Prisma.Decimal('100.00'));
    const dup = await wallet.creditRecharge('pix_1', 'client:1', new Prisma.Decimal('100.00'));
    expect(dup.posted).toBe(false);
    expect((await ledger.getBalance('client:1')).toString()).toBe('100');
  });
});
