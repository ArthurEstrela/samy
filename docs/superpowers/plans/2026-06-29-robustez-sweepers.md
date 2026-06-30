# Robustez: sweepers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recuperar estados pendurados — recargas PENDING expiradas viram EXPIRED, e saques travados em PROCESSING são reprocessados.

**Architecture:** Reaproveita a infra de `@Interval` (gated por `SCHEDULERS_ENABLED`). Saque ganha um carimbo `processingAt` pra detectar travamento; reenvio é idempotente por `payout.id`. Recarga usa um `updateMany` idempotente por `expiresAt`.

**Tech Stack:** NestJS + Prisma + Postgres. Testes via `jest-integration.json` (Postgres de teste).

## Global Constraints
- Idempotência: `expireStaleRecharges` só toca `status='PENDING' AND expiresAt < now`. `recoverStuck` só toca PROCESSING parados, re-reivindicando via `updateMany` guardado.
- `psp.sendPix` é idempotente por `payout.id` — re-tentar PROCESSING parado não dupla-paga.
- Migração aditiva: `processingAt TIMESTAMP(3) NULL`.
- Ticks só rodam com `SCHEDULERS_ENABLED='true'`; engolem exceções com log.
- `import type`; backend gate `npx tsc --noEmit`. e2e/integração via `jest-integration.json` (Postgres de teste no ar; `npm run db:test:push` após mudar schema).

---

### Task 1: `processingAt` + `recoverStuck` + refactor `settle`

**Files:**
- Modify: `prisma/schema.prisma` (Payout `+ processingAt DateTime?`)
- Create: `prisma/migrations/20260629000000_payout_processing_at/migration.sql`
- Modify: `src/payout/payout.processor.ts`
- Test: `test/payout.recover-stuck.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `LedgerService`, `PSP_PAYOUT_PORT` (`PspPayoutPort.sendPix`).
- Produces: `PayoutProcessor.recoverStuck(stuckMs?: number): Promise<void>`; claim de `processPending` passa a gravar `processingAt`; `settle(payout)` privado compartilhado.

- [ ] **Step 1: Add the column to the schema**

Em `prisma/schema.prisma`, no model `Payout`, adicionar após `processedAt`:
```prisma
  processingAt DateTime?
```

- [ ] **Step 2: Create the migration file**

Criar `prisma/migrations/20260629000000_payout_processing_at/migration.sql`:
```sql
-- AlterTable
ALTER TABLE "payouts" ADD COLUMN "processingAt" TIMESTAMP(3);
```

- [ ] **Step 3: Sync the test DB + regenerate the client**

Run: `npm run db:test:push && npx prisma generate`
Expected: schema sincronizado no Postgres de teste; client TS com `processingAt`.

- [ ] **Step 4: Write the failing test**

Harness no estilo do `test/payout.scheduler.spec.ts`, mas pegando `PayoutProcessor`.

```ts
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycModule } from '../src/kyc/kyc.module';
import { PayoutModule } from '../src/payout/payout.module';
import { PayoutProcessor } from '../src/payout/payout.processor';
import { PSP_PAYOUT_PORT } from '../src/payout/psp-payout.port';
import { FakePspPayoutPort } from '../src/payout/fake-psp-payout.adapter';

describe('PayoutProcessor.recoverStuck', () => {
  let processor: PayoutProcessor; let prisma: PrismaService; let ledger: LedgerService; let psp: FakePspPayoutPort;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, LedgerModule, KycModule, PayoutModule] })
      .overrideProvider(PSP_PAYOUT_PORT).useClass(FakePspPayoutPort).compile();
    processor = mod.get(PayoutProcessor); prisma = mod.get(PrismaService); ledger = mod.get(LedgerService); psp = mod.get(PSP_PAYOUT_PORT);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany(); await prisma.payout.deleteMany(); psp.reset();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function stuck(account: string, processingAt: Date | null): Promise<string> {
    const p = await prisma.payout.create({ data: { account, amount: new Prisma.Decimal('100.00'), status: 'PROCESSING', pixKey: 'k', processingAt } });
    return p.id;
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('reprocessa PROCESSING parado (processingAt antigo) → PAID', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const id = await stuck('model:m1', old);
    await processor.recoverStuck(120_000);
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PAID');
    expect(psp.sent).toHaveLength(1);
  });

  it('NÃO toca PROCESSING recente (dentro do limiar)', async () => {
    const id = await stuck('model:m2', new Date()); // agora
    await processor.recoverStuck(120_000);
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PROCESSING');
    expect(psp.sent).toHaveLength(0);
  });

  it('recupera PROCESSING legado (processingAt null)', async () => {
    const id = await stuck('model:m3', null);
    await processor.recoverStuck(120_000);
    expect((await prisma.payout.findUnique({ where: { id } }))?.status).toBe('PAID');
  });

  it('falha de PSP no recovery → FAILED + estorno no ledger', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const id = await stuck('model:m4', old);
    psp.failNext();
    await processor.recoverStuck(120_000);
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('FAILED');
    expect(await bal('model:m4')).toBe('100'); // estorno creditou de volta
  });

  it('processPending carimba processingAt ao reivindicar', async () => {
    await prisma.payout.create({ data: { account: 'model:m5', amount: new Prisma.Decimal('100.00'), status: 'PENDING', pixKey: 'k' } });
    await processor.processPending();
    const p = await prisma.payout.findFirst({ where: { account: 'model:m5' } });
    expect(p?.status).toBe('PAID');
    expect(p?.processingAt).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.recover-stuck.spec.ts`
Expected: FAIL (`recoverStuck` não existe; `processingAt` não carimbado).

- [ ] **Step 6: Refactor the processor**

Reescrever `src/payout/payout.processor.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Payout } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PSP_PAYOUT_PORT } from './psp-payout.port';
import type { PspPayoutPort } from './psp-payout.port';

const DEFAULT_STUCK_MS = 120_000;

@Injectable()
export class PayoutProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(PSP_PAYOUT_PORT) private readonly psp: PspPayoutPort,
  ) {}

  async processPending(): Promise<void> {
    const pending = await this.prisma.payout.findMany({ where: { status: 'PENDING' } });
    for (const payout of pending) {
      // Reivindica atomicamente antes de enviar (evita dois workers enviarem o mesmo).
      const claimed = await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'PENDING' },
        data: { status: 'PROCESSING', processingAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      await this.settle(payout);
    }
  }

  async recoverStuck(stuckMs: number = stuckMsFromEnv()): Promise<void> {
    const cutoff = new Date(Date.now() - stuckMs);
    const stuck = await this.prisma.payout.findMany({
      where: { status: 'PROCESSING', OR: [{ processingAt: { lt: cutoff } }, { processingAt: null }] },
    });
    for (const payout of stuck) {
      // Re-reivindica (renova o carimbo) — se outro worker já pegou, count !== 1.
      const claimed = await this.prisma.payout.updateMany({
        where: { id: payout.id, status: 'PROCESSING' },
        data: { processingAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      await this.settle(payout);
    }
  }

  // Envia o PIX (idempotente por payout.id) e finaliza; no erro, estorna e marca FAILED.
  private async settle(payout: Payout): Promise<void> {
    try {
      await this.psp.sendPix(payout.pixKey, payout.amount.toString(), payout.id);
      await this.prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'PAID', processedAt: new Date() },
      });
    } catch {
      await this.prisma.$transaction(async (tx) => {
        await this.ledger.postTransaction(
          `payout-reversal:${payout.id}`,
          [
            { account: payout.account, entryType: 'SAQUE_ESTORNO', amount: payout.amount },
            { account: 'source:external', entryType: 'SAQUE_ESTORNO_OFFSET', amount: payout.amount.negated() },
          ],
          tx,
        );
        await tx.payout.update({ where: { id: payout.id }, data: { status: 'FAILED', processedAt: new Date() } });
      });
    }
  }
}

function stuckMsFromEnv(): number {
  const raw = Number(process.env.PAYOUT_STUCK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STUCK_MS;
}
```

> Nota: o estorno usa `idempotencyRef` `payout-reversal:${id}#i` (via `postTransaction`). Se o recovery re-tentar um payout que já foi estornado, a violação de unique aborta — mas como `settle` só roda após re-reivindicar com sucesso e o estado já estaria FAILED (fora do filtro PROCESSING), isso não acontece no fluxo normal.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.recover-stuck.spec.ts`
Expected: PASS (5/5).

- [ ] **Step 8: Regression (fluxo de payout existente) + typecheck**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.processor.spec.ts test/payout.scheduler.spec.ts` e `npx tsc --noEmit`
Expected: PASS / sem erros.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260629000000_payout_processing_at src/payout/payout.processor.ts test/payout.recover-stuck.spec.ts
git commit -m "feat(payout): recoverStuck de saques travados em PROCESSING + processingAt"
```

---

### Task 2: `WalletService.expireStaleRecharges()`

**Files:**
- Modify: `src/wallet/wallet.service.ts`
- Test: `test/wallet.expire-recharges.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (já injetado).
- Produces: `WalletService.expireStaleRecharges(): Promise<number>`.

- [ ] **Step 1: Write the failing test**

```ts
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletModule } from '../src/wallet/wallet.module';
import { WalletService } from '../src/wallet/wallet.service';

describe('WalletService.expireStaleRecharges', () => {
  let wallet: WalletService; let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, WalletModule] }).compile();
    wallet = mod.get(WalletService); prisma = mod.get(PrismaService);
  });
  beforeEach(async () => { await prisma.recharge.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  async function rc(status: string, expiresAt: Date | null): Promise<string> {
    const u = await prisma.user.create({ data: { role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'x@y.com', displayName: 'X', status: 'ACTIVE' } });
    const r = await prisma.recharge.create({ data: { userId: u.id, amount: new Prisma.Decimal('10.00'), status, expiresAt } });
    return r.id;
  }

  it('expira PENDING vencida; preserva não-vencida e PAID', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const venc = await rc('PENDING', past);
    const naoVenc = await rc('PENDING', future);
    const paga = await rc('PAID', past);

    const n = await wallet.expireStaleRecharges();
    expect(n).toBe(1);
    expect((await prisma.recharge.findUnique({ where: { id: venc } }))?.status).toBe('EXPIRED');
    expect((await prisma.recharge.findUnique({ where: { id: naoVenc } }))?.status).toBe('PENDING');
    expect((await prisma.recharge.findUnique({ where: { id: paga } }))?.status).toBe('PAID');
  });

  it('sem vencidas → 0', async () => {
    await rc('PENDING', new Date(Date.now() + 60_000));
    expect(await wallet.expireStaleRecharges()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.expire-recharges.spec.ts`
Expected: FAIL (`expireStaleRecharges` não existe).

- [ ] **Step 3: Implement the method**

Adicionar a `WalletService` (mesma classe, qualquer posição entre métodos):
```ts
  async expireStaleRecharges(): Promise<number> {
    const res = await this.prisma.recharge.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return res.count;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.expire-recharges.spec.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 6: Commit**

```bash
git add src/wallet/wallet.service.ts test/wallet.expire-recharges.spec.ts
git commit -m "feat(wallet): expireStaleRecharges marca PENDING vencida como EXPIRED"
```

---

### Task 3: Wiring no scheduler

**Files:**
- Modify: `src/scheduler/payout.scheduler.ts` (tick chama `recoverStuck` após `processPending`)
- Create: `src/scheduler/recharge.sweeper.ts`
- Modify: `src/scheduler/scheduler.module.ts` (+ `RechargeSweeper`, importar `WalletModule`)
- Test: `test/recharge.sweeper.spec.ts`

**Interfaces:**
- Consumes: `PayoutProcessor.recoverStuck` (Task 1), `WalletService.expireStaleRecharges` (Task 2).
- Produces: `RechargeSweeper.handleTick()` (gated por `SCHEDULERS_ENABLED`).

- [ ] **Step 1: Write the failing test**

```ts
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { RechargeSweeper } from '../src/scheduler/recharge.sweeper';

describe('RechargeSweeper gate', () => {
  let sweeper: RechargeSweeper; let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [PrismaModule, SchedulerModule] }).compile();
    sweeper = mod.get(RechargeSweeper); prisma = mod.get(PrismaService);
  });
  beforeEach(async () => { await prisma.recharge.deleteMany(); await prisma.user.deleteMany(); delete process.env.SCHEDULERS_ENABLED; });
  afterAll(async () => { delete process.env.SCHEDULERS_ENABLED; await prisma.$disconnect(); });

  async function expiredPending(): Promise<string> {
    const u = await prisma.user.create({ data: { role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'x@y.com', displayName: 'X', status: 'ACTIVE' } });
    const r = await prisma.recharge.create({ data: { userId: u.id, amount: new Prisma.Decimal('10.00'), status: 'PENDING', expiresAt: new Date(Date.now() - 60_000) } });
    return r.id;
  }

  it('sem SCHEDULERS_ENABLED → não expira', async () => {
    const id = await expiredPending();
    await sweeper.handleTick();
    expect((await prisma.recharge.findUnique({ where: { id } }))?.status).toBe('PENDING');
  });

  it('com SCHEDULERS_ENABLED=true → expira vencidas', async () => {
    process.env.SCHEDULERS_ENABLED = 'true';
    const id = await expiredPending();
    await sweeper.handleTick();
    expect((await prisma.recharge.findUnique({ where: { id } }))?.status).toBe('EXPIRED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./jest-integration.json --runInBand test/recharge.sweeper.spec.ts`
Expected: FAIL (`RechargeSweeper` não existe).

- [ ] **Step 3: Create `recharge.sweeper.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { WalletService } from '../wallet/wallet.service';

const RECHARGE_SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class RechargeSweeper {
  private readonly logger = new Logger(RechargeSweeper.name);

  constructor(private readonly wallet: WalletService) {}

  @Interval(RECHARGE_SWEEP_INTERVAL_MS)
  async handleTick(): Promise<void> {
    if (process.env.SCHEDULERS_ENABLED !== 'true') return;
    try {
      const n = await this.wallet.expireStaleRecharges();
      if (n > 0) this.logger.log(`expirou ${n} recarga(s) vencida(s)`);
    } catch (err) {
      this.logger.error('recharge sweep tick failed', err as Error);
    }
  }
}
```

- [ ] **Step 4: Extend the payout tick to also recover stuck**

Em `src/scheduler/payout.scheduler.ts`, dentro do `try` do `handleTick`, após `processPending()`:
```ts
      await this.payoutProcessor.processPending();
      await this.payoutProcessor.recoverStuck();
```

- [ ] **Step 5: Register in `scheduler.module.ts`**

```ts
import { WalletModule } from '../wallet/wallet.module';
import { RechargeSweeper } from './recharge.sweeper';
// ...
@Module({
  imports: [PrismaModule, BillingModule, PayoutModule, WalletModule],
  providers: [TaximeterService, PayoutScheduler, RechargeSweeper],
  exports: [TaximeterService, PayoutScheduler, RechargeSweeper],
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest --config ./jest-integration.json --runInBand test/recharge.sweeper.spec.ts`
Expected: PASS (2/2).

- [ ] **Step 7: Regression do scheduler + typecheck**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.scheduler.spec.ts` e `npx tsc --noEmit`
Expected: PASS / sem erros.

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/payout.scheduler.ts src/scheduler/recharge.sweeper.ts src/scheduler/scheduler.module.ts test/recharge.sweeper.spec.ts
git commit -m "feat(scheduler): tick de recovery de saque + sweep de recarga expirada"
```

---

## Notas de verificação final
- `npx tsc --noEmit` limpo; suites de payout (recover-stuck, processor, scheduler) + wallet (expire) + sweeper verdes.
- Migração `payout_processing_at` presente e aplicada no banco de teste.
- Conferir idempotência: re-rodar `recoverStuck` num conjunto já resolvido não muda nada.
