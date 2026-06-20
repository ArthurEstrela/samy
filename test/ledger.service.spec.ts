import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';

describe('LedgerService', () => {
  let ledger: LedgerService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule],
    }).compile();
    ledger = moduleRef.get(LedgerService);
    prisma = moduleRef.get(PrismaService);
  });
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('posta uma transação que soma zero e calcula saldos', async () => {
    await ledger.postTransaction('call:1:min:1', [
      { account: 'client:1', entryType: 'CONSUMO_MIN', amount: new Prisma.Decimal('-5.00') },
      { account: 'model:2', entryType: 'GANHO_MIN', amount: new Prisma.Decimal('3.00') },
      { account: 'platform', entryType: 'COMISSAO', amount: new Prisma.Decimal('2.00') },
    ]);
    expect((await ledger.getBalance('client:1')).toString()).toBe('-5');
    expect((await ledger.getBalance('model:2')).toString()).toBe('3');
    expect((await ledger.getBalance('platform')).toString()).toBe('2');
  });

  it('rejeita transação que não soma zero', async () => {
    await expect(
      ledger.postTransaction('bad:1', [
        { account: 'client:1', entryType: 'CONSUMO_MIN', amount: new Prisma.Decimal('-5.00') },
        { account: 'model:2', entryType: 'GANHO_MIN', amount: new Prisma.Decimal('3.00') },
      ]),
    ).rejects.toThrow(/zero/i);
  });

  it('é idempotente: reprocessar o mesmo groupRef não duplica', async () => {
    const entries = [
      { account: 'client:1', entryType: 'RECARGA', amount: new Prisma.Decimal('100.00') },
      { account: 'source:external', entryType: 'RECARGA_OFFSET', amount: new Prisma.Decimal('-100.00') },
    ];
    const first = await ledger.postTransaction('recharge:abc', entries);
    const second = await ledger.postTransaction('recharge:abc', entries);
    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    expect((await ledger.getBalance('client:1')).toString()).toBe('100');
  });

  it('saldo de conta sem lançamentos é zero', async () => {
    expect((await ledger.getBalance('client:999')).toString()).toBe('0');
  });
});
