# Agendadores (Taxímetro + Saque) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disparar automaticamente a cobrança por minuto (taxímetro) e o pagamento de saques, com um cursor `billedMinutes` que evita N+1 no Ledger.

**Architecture:** Dois jobs in-process via `@nestjs/schedule` (`@Interval`). O taxímetro lê todas as chamadas `ACTIVE` numa única query (campo `Call.billedMinutes`, incrementado dentro da transação do `chargeMinute`) e cobra os minutos devidos. O gate (`SCHEDULERS_ENABLED`) é separado da lógica, que é chamável direto nos testes.

**Tech Stack:** NestJS 11, `@nestjs/schedule`, Prisma 5.22, Postgres, Jest (integração contra Postgres real).

## Global Constraints

- `billedMinutes` só incrementa no ramo de cobrança bem-sucedida do `chargeMinute` (após `postTransaction`, dentro da mesma `$transaction`). Idempotente-skip, NO_CREDITS e não-ACTIVE NÃO tocam o contador.
- Após cobrar o minuto `n`, `billedMinutes == n` (minutos cobrados em ordem, sem buracos).
- App boota sem `SCHEDULERS_ENABLED`; ausente/`false` → handlers viram no-op. O gate (`isEnabled()`) lê `process.env.SCHEDULERS_ENABLED === 'true'` **em tempo de chamada**.
- `.env.test` define `SCHEDULERS_ENABLED=false` (senão ticks de 10s dão flaky).
- Não alterar a semântica financeira do `chargeMinute` (split soma-zero, idempotência por `call:<id>:min:<n>`, lock por cliente, encerra em NO_CREDITS) — só somar o incremento do cursor.
- Taxímetro faz 1 query de leitura por tick (a `findMany` dos ACTIVE); nada de N leituras no Ledger.
- Um erro num `chargeMinute` de uma chamada não derruba o tick: trata cada chamada isolada (loga e segue).
- `import type` em interfaces injetadas. `npx tsc --noEmit` limpo. Migração UTF-8 sem BOM.

---

## File Structure

```
prisma/schema.prisma                              + Call.billedMinutes Int @default(0)   [mod]
prisma/migrations/20260626000000_billed_minutes/migration.sql                          [novo]
src/billing/billing.service.ts                    chargeMinute incrementa billedMinutes [mod]
test/billing.charge-minute.spec.ts                + asserts de billedMinutes            [mod]
src/scheduler/taximeter.service.ts                @Interval(10s) + runDueCharges()      [novo]
src/scheduler/payout.scheduler.ts                 @Interval(60s) + gate                 [novo]
src/scheduler/scheduler.module.ts                 importa Billing/Payout/Prisma         [novo]
src/app.module.ts                                 ScheduleModule.forRoot() + SchedulerModule [mod]
test/taximeter.spec.ts                            lógica do taxímetro (Postgres real)   [novo]
test/payout.scheduler.spec.ts                     gate liga/desliga                     [novo]
.env.example                                      SCHEDULERS_ENABLED documentado        [mod]
```

Ambiente já pronto: Docker no ar, Postgres dev (5432) e teste (5433) + Redis (6379) UP, schema de teste sincronizado. Testes de integração: `npx jest --config ./jest-integration.json --runInBand <arquivo>`.

---

## Task 1: Campo `billedMinutes` + migração

**Files:**
- Modify: `prisma/schema.prisma` (model `Call`)
- Create: `prisma/migrations/20260626000000_billed_minutes/migration.sql`
- Test: reusa `test/billing.charge-minute.spec.ts` (deve continuar verde)

**Interfaces:**
- Produces: coluna `calls.billedMinutes INTEGER NOT NULL DEFAULT 0`; campo Prisma `Call.billedMinutes: number`.

- [ ] **Step 1: Adicionar o campo ao schema**

In `prisma/schema.prisma`, model `Call`, add the field right after `endedAt DateTime?` (before the blank line and `@@index`):

```prisma
  billedMinutes          Int       @default(0)
```

- [ ] **Step 2: Criar o arquivo de migração**

Create `prisma/migrations/20260626000000_billed_minutes/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "calls" ADD COLUMN "billedMinutes" INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Regenerar o client e sincronizar o DB de teste**

Run:
```
npx prisma generate
npm run db:test:push
```
Expected: `generate` cria o client com `billedMinutes`; `db push` reporta o DB de teste em sync (coluna adicionada).

- [ ] **Step 4: Verificar que nada quebrou (billing continua verde) e tsc limpo**

Run: `npx jest --config ./jest-integration.json --runInBand test/billing.charge-minute.spec.ts`
Expected: PASS (7/7 — comportamento inalterado; a coluna existe e o client funciona).

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260626000000_billed_minutes
git commit -m "feat(calls): coluna billedMinutes (cursor de cobrança por minuto)"
```

---

## Task 2: `chargeMinute` mantém o cursor `billedMinutes`

**Files:**
- Modify: `src/billing/billing.service.ts` (método `chargeMinute`, ramo de sucesso)
- Test: `test/billing.charge-minute.spec.ts`

**Interfaces:**
- Consumes: `Call.billedMinutes` (Task 1).
- Produces: após `chargeMinute(callId, n)` com sucesso, `calls.billedMinutes == n`. Assinatura inalterada: `chargeMinute(callId: string, minuteNumber: number): Promise<ChargeResult>`.

- [ ] **Step 1: Escrever o teste que falha**

In `test/billing.charge-minute.spec.ts`, add this test at the end of the `describe` block (before the closing `});`):

```ts
  it('mantém billedMinutes: incrementa ao cobrar, não no caminho idempotente', async () => {
    const { callId } = await setup({ credit: '20.00' });
    await billing.chargeMinute(callId, 1);
    let call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(1);
    await billing.chargeMinute(callId, 1); // idempotente — não sobe
    call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(1);
    await billing.chargeMinute(callId, 2);
    call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(2);
  });

  it('NO_CREDITS não incrementa billedMinutes', async () => {
    const { callId } = await setup({ price: '5.00', credit: '3.00' });
    await billing.chargeMinute(callId, 1);
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(0);
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/billing.charge-minute.spec.ts -t billedMinutes`
Expected: FAIL — o primeiro `expect(call?.billedMinutes).toBe(1)` recebe `0` (incremento ainda não implementado).

- [ ] **Step 3: Implementar o incremento**

In `src/billing/billing.service.ts`, in `chargeMinute`, locate the success branch — the `postTransaction` call that ends with `return { charged: true };`. Insert the increment between the `postTransaction` and the `return`:

```ts
      await this.ledger.postTransaction(
        group,
        [
          { account: `client:${fresh.clientUserId}`, entryType: 'CONSUMO_MIN', amount: price.negated() },
          { account: `model:${fresh.modelUserId}`, entryType: 'GANHO_MIN', amount: modelShare },
          { account: 'platform', entryType: 'COMISSAO', amount: commission },
        ],
        tx,
      );
      await tx.call.update({ where: { id: callId }, data: { billedMinutes: { increment: 1 } } });
      return { charged: true };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/billing.charge-minute.spec.ts`
Expected: PASS (9/9 — os 7 originais + os 2 novos).

- [ ] **Step 5: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add src/billing/billing.service.ts test/billing.charge-minute.spec.ts
git commit -m "feat(billing): chargeMinute incrementa billedMinutes na mesma transação"
```

---

## Task 3: TaximeterService + wiring do scheduling

**Files:**
- Modify: `package.json` (dep `@nestjs/schedule`)
- Create: `src/scheduler/taximeter.service.ts`
- Create: `src/scheduler/scheduler.module.ts`
- Modify: `src/app.module.ts` (`ScheduleModule.forRoot()` + `SchedulerModule`)
- Modify: `.env.test` (append `SCHEDULERS_ENABLED=false`)
- Test: `test/taximeter.spec.ts`

**Interfaces:**
- Consumes: `BillingService.chargeMinute(callId, n): Promise<ChargeResult>` onde `ChargeResult` tem `ended?: boolean` (de `src/billing/billing.service.ts`); `PrismaService`. `Call.billedMinutes` (Task 1).
- Produces: `TaximeterService.runDueCharges(now?: Date): Promise<void>` (cobra minutos devidos de toda chamada ACTIVE); `@Interval(10000) handleTick()` que delega se habilitado. `SchedulerModule` exporta os providers de scheduling.

- [ ] **Step 1: Instalar o @nestjs/schedule**

Run: `npm install @nestjs/schedule`
Expected: `@nestjs/schedule` em `dependencies`.

- [ ] **Step 2: Garantir o gate desligado nos testes**

Append to `.env.test` (arquivo local, gitignored) on its own line:

```
SCHEDULERS_ENABLED=false
```

Run (sanity, opcional): confirme que o arquivo termina com essa linha. (Se ausente, `isEnabled()` já retorna false; isto torna explícito.)

- [ ] **Step 3: Escrever o teste do taxímetro que falha**

Create `test/taximeter.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TaximeterService } from '../src/scheduler/taximeter.service';

describe('TaximeterService.runDueCharges', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let taximeter: TaximeterService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    taximeter = mod.get(TaximeterService);
  });
  beforeEach(async () => {
    await prisma.gift.deleteMany();
    await prisma.giftType.deleteMany();
    await prisma.call.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function setup(opts: { price?: string; credit?: string; startedSecAgo?: number }): Promise<{ callId: string; clientId: string }> {
    const model = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `ms-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: model.id, stageName: 'S', pricePerMinute: new Prisma.Decimal(opts.price ?? '5.00'), tags: [] } });
    const client = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `cs-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    if (opts.credit) {
      await ledger.postTransaction(`seed:${client.id}`, [
        { account: `client:${client.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal(opts.credit) },
        { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(opts.credit).negated() },
      ]);
    }
    const startedAt = new Date(Date.now() - (opts.startedSecAgo ?? 0) * 1000);
    const call = await prisma.call.create({ data: { clientUserId: client.id, modelUserId: model.id, status: 'ACTIVE', pricePerMinuteSnapshot: new Prisma.Decimal(opts.price ?? '5.00'), startedAt } });
    return { callId: call.id, clientId: client.id };
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('cobra todos os minutos devidos (1..3) de uma chamada 130s ativa', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 130 });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('35'); // 50 - 3*5
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(3);
    expect(call?.status).toBe('ACTIVE');
  });

  it('encerra em NO_CREDITS quando o saldo acaba no meio', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '10.00', startedSecAgo: 130 });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('0'); // cobrou min1+min2
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.status).toBe('ENDED');
    expect(call?.endReason).toBe('NO_CREDITS');
    expect(call?.billedMinutes).toBe(2);
  });

  it('idempotente: rodar de novo não cobra de novo', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 130 });
    await taximeter.runDueCharges();
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('35');
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(3);
  });

  it('ignora chamadas não-ACTIVE', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 130 });
    await prisma.call.update({ where: { id: callId }, data: { status: 'ENDED', endReason: 'HANGUP_CLIENT' } });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('50');
  });

  it('chamada recém-iniciada cobra só o minuto 1', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '50.00', startedSecAgo: 0 });
    await taximeter.runDueCharges();
    expect(await bal(`client:${clientId}`)).toBe('45');
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.billedMinutes).toBe(1);
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/taximeter.spec.ts`
Expected: FAIL — `TaximeterService` e `SchedulerModule` não existem (erro de import/compilação).

- [ ] **Step 5: Criar o TaximeterService**

Create `src/scheduler/taximeter.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

const TAXIMETER_INTERVAL_MS = 10_000;

@Injectable()
export class TaximeterService {
  private readonly logger = new Logger(TaximeterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  @Interval(TAXIMETER_INTERVAL_MS)
  async handleTick(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    await this.runDueCharges();
  }

  async runDueCharges(now: Date = new Date()): Promise<void> {
    const calls = await this.prisma.call.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, startedAt: true, billedMinutes: true },
    });
    for (const c of calls) {
      if (!c.startedAt) {
        continue;
      }
      const dueMinute = Math.floor((now.getTime() - c.startedAt.getTime()) / 60_000) + 1;
      for (let n = c.billedMinutes + 1; n <= dueMinute; n++) {
        try {
          const r = await this.billing.chargeMinute(c.id, n);
          if (r.ended) {
            break;
          }
        } catch (err) {
          this.logger.error(`taximeter charge failed for call ${c.id} minute ${n}`, err as Error);
          break;
        }
      }
    }
  }

  private isEnabled(): boolean {
    return process.env.SCHEDULERS_ENABLED === 'true';
  }
}
```

- [ ] **Step 6: Criar o SchedulerModule**

Create `src/scheduler/scheduler.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { TaximeterService } from './taximeter.service';

@Module({
  imports: [PrismaModule, BillingModule],
  providers: [TaximeterService],
  exports: [TaximeterService],
})
export class SchedulerModule {}
```

- [ ] **Step 7: Ligar no AppModule**

In `src/app.module.ts`, add the imports and register them. Add near the other imports:

```ts
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerModule } from './scheduler/scheduler.module';
```

In the `imports: [...]` array, add `ScheduleModule.forRoot()` and `SchedulerModule` (após `BillingModule`):

```ts
    BillingModule,
    ScheduleModule.forRoot(),
    SchedulerModule,
```

- [ ] **Step 8: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/taximeter.spec.ts`
Expected: PASS (5/5).

- [ ] **Step 9: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add package.json package-lock.json src/scheduler/taximeter.service.ts src/scheduler/scheduler.module.ts src/app.module.ts test/taximeter.spec.ts
git commit -m "feat(scheduler): taxímetro @Interval(10s) cobra minutos devidos (1 query por tick)"
```

---

## Task 4: PayoutScheduler (gate liga/desliga)

**Files:**
- Create: `src/scheduler/payout.scheduler.ts`
- Modify: `src/scheduler/scheduler.module.ts` (importa `PayoutModule`, provê `PayoutScheduler`)
- Test: `test/payout.scheduler.spec.ts`

**Interfaces:**
- Consumes: `PayoutProcessor.processPending(): Promise<void>` (de `src/payout/payout.processor.ts`, exportado por `PayoutModule`).
- Produces: `PayoutScheduler.handleTick(): Promise<void>` (chama `processPending()` se habilitado).

- [ ] **Step 1: Escrever o teste do gate que falha**

Create `test/payout.scheduler.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycModule } from '../src/kyc/kyc.module';
import { PayoutModule } from '../src/payout/payout.module';
import { PayoutService } from '../src/payout/payout.service';
import { SchedulerModule } from '../src/scheduler/scheduler.module';
import { PayoutScheduler } from '../src/scheduler/payout.scheduler';
import { PSP_PAYOUT_PORT } from '../src/payout/psp-payout.port';
import { FakePspPayoutPort } from '../src/payout/fake-psp-payout.adapter';

describe('PayoutScheduler gate', () => {
  let scheduler: PayoutScheduler;
  let payoutSvc: PayoutService;
  let ledger: LedgerService;
  let prisma: PrismaService;
  let fakePsp: FakePspPayoutPort;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, KycModule, PayoutModule, SchedulerModule],
    })
      .overrideProvider(PSP_PAYOUT_PORT)
      .useClass(FakePspPayoutPort)
      .compile();
    scheduler = mod.get(PayoutScheduler);
    payoutSvc = mod.get(PayoutService);
    ledger = mod.get(LedgerService);
    prisma = mod.get(PrismaService);
    fakePsp = mod.get(PSP_PAYOUT_PORT);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.payout.deleteMany();
    await prisma.kycStatus.deleteMany();
    fakePsp.reset();
    delete process.env.SCHEDULERS_ENABLED;
  });
  afterAll(async () => {
    delete process.env.SCHEDULERS_ENABLED;
    await prisma.$disconnect();
  });

  async function seedPending(account: string): Promise<string> {
    await prisma.kycStatus.create({ data: { account, approved: true } });
    await ledger.postTransaction(`seed:${account}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('300.00') },
      { account: 'source:external', entryType: 'SEED_OFFSET', amount: new Prisma.Decimal('-300.00') },
    ]);
    const p = await payoutSvc.requestPayout(account, new Prisma.Decimal('300.00'), 'k');
    return p.id;
  }

  it('habilitado: handleTick processa o PENDING (vira PAID)', async () => {
    const id = await seedPending('model:sch1');
    process.env.SCHEDULERS_ENABLED = 'true';
    await scheduler.handleTick();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PAID');
    expect(fakePsp.sent).toHaveLength(1);
  });

  it('desabilitado: handleTick não toca o PENDING', async () => {
    const id = await seedPending('model:sch2');
    process.env.SCHEDULERS_ENABLED = 'false';
    await scheduler.handleTick();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PENDING');
    expect(fakePsp.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.scheduler.spec.ts`
Expected: FAIL — `PayoutScheduler` não existe.

- [ ] **Step 3: Criar o PayoutScheduler**

Create `src/scheduler/payout.scheduler.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PayoutProcessor } from '../payout/payout.processor';

const PAYOUT_INTERVAL_MS = 60_000;

@Injectable()
export class PayoutScheduler {
  private readonly logger = new Logger(PayoutScheduler.name);

  constructor(private readonly payoutProcessor: PayoutProcessor) {}

  @Interval(PAYOUT_INTERVAL_MS)
  async handleTick(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    try {
      await this.payoutProcessor.processPending();
    } catch (err) {
      this.logger.error('payout processing tick failed', err as Error);
    }
  }

  private isEnabled(): boolean {
    return process.env.SCHEDULERS_ENABLED === 'true';
  }
}
```

- [ ] **Step 4: Registrar no SchedulerModule**

Replace the entire contents of `src/scheduler/scheduler.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { PayoutModule } from '../payout/payout.module';
import { TaximeterService } from './taximeter.service';
import { PayoutScheduler } from './payout.scheduler';

@Module({
  imports: [PrismaModule, BillingModule, PayoutModule],
  providers: [TaximeterService, PayoutScheduler],
  exports: [TaximeterService, PayoutScheduler],
})
export class SchedulerModule {}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.scheduler.spec.ts`
Expected: PASS (2/2).

- [ ] **Step 6: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add src/scheduler/payout.scheduler.ts src/scheduler/scheduler.module.ts test/payout.scheduler.spec.ts
git commit -m "feat(scheduler): processador de saque @Interval(60s) com gate SCHEDULERS_ENABLED"
```

---

## Task 5: Documentar env + verificação final

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Documentar `SCHEDULERS_ENABLED` no `.env.example`**

In `.env.example`, in the "Opcionais / com default" section (após a linha `CORS_ORIGIN="*"...`), add:

```bash
SCHEDULERS_ENABLED="true"           # liga taxímetro (10s) + processador de saque (60s); false p/ réplicas extras
```

- [ ] **Step 2: Rodar a suíte completa**

Run: `npm run test:int`
Expected: todas as suítes verdes (as anteriores + taximeter 5 + payout.scheduler 2 + billing 9). Output sem ruído além dos ERROR esperados de detecção de reuso de refresh token.

- [ ] **Step 3: tsc final**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 4: Commit e push**

```bash
git add .env.example
git commit -m "docs(scheduler): documenta SCHEDULERS_ENABLED no .env.example"
git push origin main
```

---

## Self-Review (autor)

**Cobertura do spec:**
- §1/§5.1 schema `billedMinutes` + migração → Task 1. ✓
- §3/§5.2 incremento no ramo de sucesso, não em idempotente/NO_CREDITS → Task 2 (+2 testes). ✓
- §1/§5.3 taxímetro 10s, 1 query, cobra 1..dueMinute, break em NO_CREDITS → Task 3. ✓
- §1/§5.4 payout scheduler 60s + gate → Task 4. ✓
- §2/§5.6 gate `SCHEDULERS_ENABLED` em tempo de chamada, `.env.test=false`, `.env.example` → Tasks 3 (env.test) e 5 (env.example). ✓
- §6 erro por chamada não derruba o tick (try/catch + log + segue) → Task 3 `runDueCharges`. ✓
- §7 testes determinísticos via `runDueCharges(now)`/`handleTick` direto → Tasks 3, 4. ✓

**Consistência de tipos:** `runDueCharges(now?: Date)`, `handleTick()`, `chargeMinute(callId, n): Promise<ChargeResult>` com `ended?` — usados igual em todas as tasks. `billedMinutes: number` (Prisma `Int`). `SchedulerModule` exporta `TaximeterService`/`PayoutScheduler`, consumidos pelos testes.

**Placeholders:** nenhum — todo passo tem código/comando concreto.

**Nota de escopo:** eleição de líder e recuperação de PROCESSING travado ficam fora (documentado no spec); seguro rodar em N instâncias por idempotência+CAS+lock.
