import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerEntryInput } from './ledger.types';

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async postTransaction(
    groupRef: string,
    entries: LedgerEntryInput[],
    tx?: Prisma.TransactionClient,
  ): Promise<{ posted: boolean }> {
    const total = entries.reduce(
      (acc, e) => acc.add(e.amount),
      new Prisma.Decimal(0),
    );
    if (!total.isZero()) {
      throw new BadRequestException('Transaction does not balance to zero');
    }

    const data = entries.map((e, i) => ({
      account: e.account,
      entryType: e.entryType,
      amount: e.amount,
      transactionGroup: groupRef,
      idempotencyRef: `${groupRef}#${i}`,
      metadata: e.metadata,
    }));

    const run = async (client: Prisma.TransactionClient): Promise<void> => {
      await client.ledgerEntry.createMany({ data });
    };

    if (tx) {
      // Caller-managed transaction: a unique violation aborts the caller's
      // surrounding Postgres transaction. Swallowing it and returning
      // { posted: false } would leave the caller running inside an aborted
      // transaction, so we let P2002 (and any error) propagate.
      await run(tx);
      return { posted: true };
    }

    // Self-managed transaction: P2002 means a webhook replay / duplicate
    // groupRef. Treat it as an idempotent no-op.
    try {
      await this.prisma.$transaction(run);
      return { posted: true };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { posted: false };
      }
      throw err;
    }
  }

  async getBalance(
    account: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const client = tx ?? this.prisma;
    const result = await client.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { account },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }
}
