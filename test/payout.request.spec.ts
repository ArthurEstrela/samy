import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { WalletModule } from '../src/wallet/wallet.module';
import { WalletService } from '../src/wallet/wallet.service';
import { KycModule } from '../src/kyc/kyc.module';
import { PayoutModule } from '../src/payout/payout.module';
import { PayoutService } from '../src/payout/payout.service';

describe('PayoutService.requestPayout', () => {
  let payout: PayoutService;
  let wallet: WalletService;
  let ledger: LedgerService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, WalletModule, KycModule, PayoutModule],
    }).compile();
    payout = moduleRef.get(PayoutService);
    wallet = moduleRef.get(WalletService);
    ledger = moduleRef.get(LedgerService);
    prisma = moduleRef.get(PrismaService);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.payout.deleteMany();
    await prisma.kycStatus.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function fundModel(account: string, amount: string): Promise<void> {
    // injeta saldo na modelo via uma transação soma-zero contra source:external
    await ledger.postTransaction(`seed:${account}:${amount}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED_OFFSET', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }

  it('cria payout PENDING e debita o saldo da modelo quando KYC ok e acima do mínimo', async () => {
    await prisma.kycStatus.create({ data: { account: 'model:2', approved: true } });
    await fundModel('model:2', '300.00');

    const p = await payout.requestPayout('model:2', new Prisma.Decimal('300.00'), 'chave-pix-x');

    expect(p.status).toBe('PENDING');
    expect((await ledger.getBalance('model:2')).toString()).toBe('0');
  });

  it('recusa saque sem KYC aprovado', async () => {
    await fundModel('model:3', '300.00');
    await expect(
      payout.requestPayout('model:3', new Prisma.Decimal('300.00'), 'k'),
    ).rejects.toThrow(/kyc/i);
  });

  it('recusa saque abaixo do mínimo', async () => {
    await prisma.kycStatus.create({ data: { account: 'model:4', approved: true } });
    await fundModel('model:4', '300.00');
    await expect(
      payout.requestPayout('model:4', new Prisma.Decimal('50.00'), 'k'),
    ).rejects.toThrow(/minim/i);
  });

  it('recusa saque maior que o saldo', async () => {
    await prisma.kycStatus.create({ data: { account: 'model:5', approved: true } });
    await fundModel('model:5', '250.00');
    await expect(
      payout.requestPayout('model:5', new Prisma.Decimal('300.00'), 'k'),
    ).rejects.toThrow(/saldo|balance/i);
  });

  it('serializa payouts concorrentes da mesma conta (sem double-spend)', async () => {
    // Cada conta tem saldo suficiente para EXATAMENTE um payout (300, MIN 200,
    // request 300 x2). Sem lock por conta, o TOCTOU deixa ambos os payouts
    // passarem (saldo final -300). Várias contas para expor a corrida de forma
    // determinística independente de timing de conexão.
    const accounts = ['race:1', 'race:2', 'race:3', 'race:4', 'race:5'];

    for (const acc of accounts) {
      await prisma.kycStatus.create({ data: { account: acc, approved: true } });
      await fundModel(acc, '300.00');

      const results = await Promise.allSettled([
        payout.requestPayout(acc, new Prisma.Decimal('300.00'), 'k'),
        payout.requestPayout(acc, new Prisma.Decimal('300.00'), 'k'),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        message: expect.stringMatching(/saldo|balance/i),
      });
      // Nunca pode ficar negativo: exatamente um payout debitou os 300.
      expect((await ledger.getBalance(acc)).toString()).toBe('0');
    }
  });
});
