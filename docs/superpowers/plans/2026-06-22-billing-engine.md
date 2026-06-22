# Billing Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o motor de faturamento da Samy — o taxímetro (`chargeMinute`, cobra um minuto de chamada ATIVA com split soma-zero, encerra a chamada se o saldo acabar) e os gifts (catálogo + `sendGift`, mesmo split), com take rate global+override e serialização por cliente.

**Architecture:** NestJS + Prisma + Postgres. Split soma-zero rounding-safe via `LedgerService.postTransaction` (idempotente por groupRef). Toda operação que debita o cliente (`chargeMinute`, `sendGift`) roda em `$transaction` sob `pg_advisory_xact_lock(hashtext('call-client:'+clientId))` — a MESMA chave do Motor de Chamadas — então minuto × gift × nova-chamada serializam e o saldo nunca fica negativo. O agendador do taxímetro fica de fora (follow-up); o motor é testável chamando `chargeMinute` direto. Billing lê/encerra a `Call` via Prisma inline (não importa CallsModule → sem ciclo).

**Tech Stack:** NestJS, Prisma v5.22.0, PostgreSQL, Jest (integração contra Postgres real), supertest (gifts e2e).

## Global Constraints

- **Split soma-zero rounding-safe:** `commission = (price × takeRate).toDecimalPlaces(2, ROUND_HALF_UP)`; `modelShare = price − commission`. Lançamentos cliente `−price`, modelo `+modelShare`, plataforma `+commission` → soma 0. Dinheiro sempre `Prisma.Decimal`, nunca float.
- **Idempotência:** minuto via groupRef `call:<callId>:min:<n>`; gift via `gift:<giftId>`. Pré-checagem por `transactionGroup` ANTES de avaliar saldo/encerrar (re-cobrar o mesmo minuto é no-op puro).
- **Advisory lock `call-client:<clientId>`** (idêntico ao Motor de Chamadas) em `chargeMinute` e `sendGift`, dentro de `$transaction`. `getBalance` lido com o `tx`.
- **`chargeMinute` só cobra ACTIVE.** Saldo `< price` → encerra inline (`tx.call.updateMany({where:{id, status:'ACTIVE'}, data:{ENDED, NO_CREDITS, endedAt}})`), NÃO cobra.
- **`sendGift`** exige `GiftType` ativo + modelo `role=MODEL` + saldo ≥ preço (senão 404/402); funciona com modelo offline/sem-perfil (takeRate cai no global).
- **Take rate:** `resolveTakeRate(model.takeRate ?? null, GLOBAL_TAKE_RATE)`. `GLOBAL_TAKE_RATE` por env, lido no construtor do `BillingService` (fail-fast se ausente).
- **Billing NÃO importa CallsModule** (lê/encerra Call via Prisma inline) — sem ciclo. Não altera ledger/identidade/kyc; Marketplace muda só com a coluna `takeRate`.
- **`npx tsc --noEmit` limpo;** `import type` em interfaces injetadas.
- **Migração não-interativa** (migrate diff + deploy, UTF-8 sem BOM); teste via `db:test:push`. Append em `.env` com newline inicial.
- **Conta:** `client:<id>` / `model:<id>` / `platform`.

---

### Task 1: Schema (ModelProfile.takeRate + GiftType + Gift) + env

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260622020000_billing/migration.sql`
- Modify: `.env`, `.env.test`
- Test: `test/billing-schema.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient`.
- Produces: coluna `model_profiles.takeRate` (nullable); tabelas `gift_types`, `gifts`; tipos `GiftType`, `Gift`.

- [ ] **Step 1: Escrever o teste que falha**

Create `test/billing-schema.spec.ts`:
```typescript
import { PrismaClient, Prisma } from '@prisma/client';

describe('billing schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => {
    await prisma.gift.deleteMany();
    await prisma.giftType.deleteMany();
    await prisma.modelProfile.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('ModelProfile aceita takeRate nulo e decimal', async () => {
    const a = await prisma.modelProfile.create({ data: { userId: 'u1', stageName: 'A', pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    expect(a.takeRate).toBeNull();
    const b = await prisma.modelProfile.create({ data: { userId: 'u2', stageName: 'B', pricePerMinute: new Prisma.Decimal('5.00'), tags: [], takeRate: new Prisma.Decimal('0.30') } });
    expect(b.takeRate?.toString()).toBe('0.3');
  });

  it('GiftType e Gift persistem', async () => {
    const gt = await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    expect(gt.active).toBe(true);
    const g = await prisma.gift.create({ data: { clientUserId: 'c1', modelUserId: 'm1', giftTypeId: gt.id, priceSnapshot: new Prisma.Decimal('10.00') } });
    expect(g.priceSnapshot.toString()).toBe('10');
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/billing-schema.spec.ts`
Expected: FAIL — `takeRate`/`prisma.giftType` não existem.

- [ ] **Step 3: Editar o schema**

In `prisma/schema.prisma`, add `takeRate` to the existing `ModelProfile` model (after `voicePreviewUrl`):
```prisma
  takeRate        Decimal? @db.Decimal(5, 4)
```
And add the two new models (após os existentes):
```prisma
model GiftType {
  id           String   @id @default(uuid())
  name         String
  priceCredits Decimal  @db.Decimal(14, 2)
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())

  @@map("gift_types")
}

model Gift {
  id            String   @id @default(uuid())
  clientUserId  String
  modelUserId   String
  giftTypeId    String
  priceSnapshot Decimal  @db.Decimal(14, 2)
  createdAt     DateTime @default(now())

  @@index([modelUserId])
  @@map("gifts")
}
```

- [ ] **Step 4: Gerar migration não-interativa e aplicar**

Run (Bash/Git Bash p/ UTF-8 sem BOM):
```bash
mkdir -p prisma/migrations/20260622020000_billing
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260622020000_billing/migration.sql
npx prisma generate
npx prisma migrate deploy
```
Confirme: `ALTER TABLE "model_profiles" ADD COLUMN "takeRate"`, `CREATE TABLE "gift_types"`, `CREATE TABLE "gifts"`; sem dropar outras tabelas. P3018 (BOM) → reescreva UTF-8 sem BOM. (model_profiles deve estar vazio no dev; se o ADD COLUMN nullable falhar, reporte.)

- [ ] **Step 5: Adicionar o env (com newline inicial!)**

Run:
```bash
printf '\nGLOBAL_TAKE_RATE="0.40"\n' >> .env
printf '\nGLOBAL_TAKE_RATE="0.40"\n' >> .env.test
```
Confirme com `tail -2 .env.test` que está em linha própria.

- [ ] **Step 6: Rodar o teste**

Run: `npm run test:int -- test/billing-schema.spec.ts`
Expected: PASS (2 testes).

- [ ] **Step 7: Commit**

```bash
git add prisma test/billing-schema.spec.ts
git commit -m "feat(billing): ModelProfile.takeRate + GiftType/Gift schema + GLOBAL_TAKE_RATE env"
```

---

### Task 2: take-rate.ts (resolveTakeRate + computeSplit, puros)

**Files:**
- Create: `src/billing/take-rate.ts`
- Test: `test/take-rate.spec.ts`

**Interfaces:**
- Consumes: `Prisma.Decimal`.
- Produces:
  - `resolveTakeRate(override: Prisma.Decimal | null, fallback: Prisma.Decimal): Prisma.Decimal` — `override ?? fallback`.
  - `computeSplit(price: Prisma.Decimal, takeRate: Prisma.Decimal): { commission: Prisma.Decimal; modelShare: Prisma.Decimal }` — `commission = round(price×takeRate, 2 HALF_UP)`, `modelShare = price − commission` (sempre `commission + modelShare === price`).

- [ ] **Step 1: Escrever o teste**

Create `test/take-rate.spec.ts`:
```typescript
import { Prisma } from '@prisma/client';
import { resolveTakeRate, computeSplit } from '../src/billing/take-rate';

const D = (v: string): Prisma.Decimal => new Prisma.Decimal(v);

describe('take-rate', () => {
  it('resolveTakeRate usa override quando presente, senão o fallback', () => {
    expect(resolveTakeRate(D('0.30'), D('0.40')).toString()).toBe('0.3');
    expect(resolveTakeRate(null, D('0.40')).toString()).toBe('0.4');
  });

  it('computeSplit: preço inteiro divide certinho e soma zero', () => {
    const { commission, modelShare } = computeSplit(D('5.00'), D('0.40'));
    expect(commission.toString()).toBe('2');
    expect(modelShare.toString()).toBe('3');
    expect(commission.plus(modelShare).toString()).toBe('5');
  });

  it('computeSplit: preço ímpar arredonda a comissão e modelShare = preço − comissão (soma exata)', () => {
    const price = D('5.01');
    const { commission, modelShare } = computeSplit(price, D('0.40')); // 2.004 -> 2.00
    expect(commission.toString()).toBe('2');
    expect(modelShare.toString()).toBe('3.01');
    expect(commission.plus(modelShare).equals(price)).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/take-rate.spec.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

Create `src/billing/take-rate.ts`:
```typescript
import { Prisma } from '@prisma/client';

export function resolveTakeRate(
  override: Prisma.Decimal | null,
  fallback: Prisma.Decimal,
): Prisma.Decimal {
  return override ?? fallback;
}

export function computeSplit(
  price: Prisma.Decimal,
  takeRate: Prisma.Decimal,
): { commission: Prisma.Decimal; modelShare: Prisma.Decimal } {
  const commission = price.mul(takeRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const modelShare = price.minus(commission);
  return { commission, modelShare };
}
```

- [ ] **Step 4: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/take-rate.spec.ts
npx tsc --noEmit
```
Expected: PASS (3 testes) e tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/billing/take-rate.ts test/take-rate.spec.ts
git commit -m "feat(billing): rounding-safe split (computeSplit) + resolveTakeRate"
```

---

### Task 3: BillingService.chargeMinute + módulo + wiring

**Files:**
- Create: `src/billing/billing.service.ts`
- Create: `src/billing/billing.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/billing.charge-minute.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `LedgerService.postTransaction(group, entries, tx?)` + `getBalance(account, tx?)`; `resolveTakeRate`/`computeSplit` (Task 2).
- Produces:
  - `ChargeResult = { charged: boolean; alreadyCharged?: boolean; ended?: boolean; reason?: string }`.
  - `BillingService.chargeMinute(callId: string, minuteNumber: number): Promise<ChargeResult>`.
  - private `lock(tx, key)`; readonly `globalTakeRate` (env, fail-fast).
  - `BillingModule` (imports Prisma, Ledger, Auth, Users; provê+exporta BillingService). Registrado em AppModule.

- [ ] **Step 1: Escrever o teste**

Create `test/billing.charge-minute.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { BillingService } from '../src/billing/billing.service';

describe('BillingService.chargeMinute', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let billing: BillingService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    billing = mod.get(BillingService);
  });
  beforeEach(async () => {
    await prisma.call.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function setup(opts: { price?: string; credit?: string; takeRate?: string } = {}): Promise<{ callId: string; clientId: string; modelId: string }> {
    const model = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `ms-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: model.id, stageName: 'S', pricePerMinute: new Prisma.Decimal(opts.price ?? '5.00'), tags: [], takeRate: opts.takeRate ? new Prisma.Decimal(opts.takeRate) : null } });
    const client = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `cs-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    if (opts.credit) {
      await ledger.postTransaction(`seed:${client.id}`, [
        { account: `client:${client.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal(opts.credit) },
        { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(opts.credit).negated() },
      ]);
    }
    const call = await prisma.call.create({ data: { clientUserId: client.id, modelUserId: model.id, status: 'ACTIVE', pricePerMinuteSnapshot: new Prisma.Decimal(opts.price ?? '5.00'), startedAt: new Date() } });
    return { callId: call.id, clientId: client.id, modelId: model.id };
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('cobra o split correto (take rate global 0.40) e soma zero', async () => {
    const { callId, clientId, modelId } = await setup({ price: '5.00', credit: '20.00' });
    const r = await billing.chargeMinute(callId, 1);
    expect(r.charged).toBe(true);
    expect(await bal(`client:${clientId}`)).toBe('15');
    expect(await bal(`model:${modelId}`)).toBe('3');
    expect(await bal('platform')).toBe('2');
  });

  it('idempotente: cobrar o mesmo minuto duas vezes debita uma vez só', async () => {
    const { callId, clientId } = await setup({ credit: '20.00' });
    await billing.chargeMinute(callId, 1);
    const r2 = await billing.chargeMinute(callId, 1);
    expect(r2.charged).toBe(false);
    expect(r2.alreadyCharged).toBe(true);
    expect(await bal(`client:${clientId}`)).toBe('15');
  });

  it('saldo insuficiente → encerra a chamada (NO_CREDITS) e não cobra', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '3.00' });
    const r = await billing.chargeMinute(callId, 1);
    expect(r.ended).toBe(true);
    expect(r.charged).toBe(false);
    expect(await bal(`client:${clientId}`)).toBe('3');
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.status).toBe('ENDED');
    expect(call?.endReason).toBe('NO_CREDITS');
  });

  it('não cobra chamada não-ACTIVE', async () => {
    const { callId } = await setup({ credit: '20.00' });
    await prisma.call.update({ where: { id: callId }, data: { status: 'ENDED', endReason: 'HANGUP_CLIENT' } });
    const r = await billing.chargeMinute(callId, 1);
    expect(r.charged).toBe(false);
    expect(r.reason).toBe('not_active');
  });

  it('rounding-safe: preço 5.01 com 0.40 → comissão 2.00, modelo 3.01, soma zero', async () => {
    const { callId, clientId, modelId } = await setup({ price: '5.01', credit: '20.00' });
    await billing.chargeMinute(callId, 1);
    expect(await bal(`model:${modelId}`)).toBe('3.01');
    expect(await bal('platform')).toBe('2');
    expect(await bal(`client:${clientId}`)).toBe('14.99');
  });

  it('override de takeRate (0.30) tem precedência sobre o global', async () => {
    const { callId, modelId } = await setup({ price: '5.00', credit: '20.00', takeRate: '0.30' });
    await billing.chargeMinute(callId, 1);
    expect(await bal('platform')).toBe('1.5');
    expect(await bal(`model:${modelId}`)).toBe('3.5');
  });

  it('serialização: chargeMinute + outra op concorrente não deixam o saldo negativo', async () => {
    const { callId, clientId } = await setup({ price: '5.00', credit: '5.00' });
    // dois chargeMinute concorrentes de minutos DIFERENTES, saldo só p/ 1
    const [r1, r2] = await Promise.allSettled([
      billing.chargeMinute(callId, 1),
      billing.chargeMinute(callId, 2),
    ]);
    const charged = [r1, r2].filter((r) => r.status === 'fulfilled' && r.value.charged === true);
    expect(charged).toHaveLength(1); // só um minuto coube; o outro encerrou/não cobrou
    const balance = await ledger.getBalance(`client:${clientId}`);
    expect(balance.greaterThanOrEqualTo(0)).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/billing.charge-minute.spec.ts`
Expected: FAIL — `BillingService` inexistente.

- [ ] **Step 3: Implementar o BillingService (chargeMinute)**

Create `src/billing/billing.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { resolveTakeRate, computeSplit } from './take-rate';

export interface ChargeResult {
  charged: boolean;
  alreadyCharged?: boolean;
  ended?: boolean;
  reason?: string;
}

@Injectable()
export class BillingService {
  private readonly globalTakeRate: Prisma.Decimal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {
    const raw = process.env.GLOBAL_TAKE_RATE;
    if (!raw) {
      throw new Error('GLOBAL_TAKE_RATE env var is required');
    }
    this.globalTakeRate = new Prisma.Decimal(raw);
  }

  async chargeMinute(callId: string, minuteNumber: number): Promise<ChargeResult> {
    return this.prisma.$transaction(async (tx) => {
      const call = await tx.call.findUnique({ where: { id: callId } });
      if (!call) {
        return { charged: false, reason: 'not_found' };
      }
      await this.lock(tx, `call-client:${call.clientUserId}`);

      const group = `call:${callId}:min:${minuteNumber}`;
      const existing = await tx.ledgerEntry.findFirst({ where: { transactionGroup: group } });
      if (existing) {
        return { charged: false, alreadyCharged: true };
      }
      if (call.status !== 'ACTIVE') {
        return { charged: false, reason: 'not_active' };
      }

      const price = call.pricePerMinuteSnapshot;
      const balance = await this.ledger.getBalance(`client:${call.clientUserId}`, tx);
      if (balance.lessThan(price)) {
        await tx.call.updateMany({
          where: { id: callId, status: 'ACTIVE' },
          data: { status: 'ENDED', endReason: 'NO_CREDITS', endedAt: new Date() },
        });
        return { charged: false, ended: true };
      }

      const profile = await tx.modelProfile.findUnique({ where: { userId: call.modelUserId } });
      const takeRate = resolveTakeRate(profile?.takeRate ?? null, this.globalTakeRate);
      const { commission, modelShare } = computeSplit(price, takeRate);
      await this.ledger.postTransaction(
        group,
        [
          { account: `client:${call.clientUserId}`, entryType: 'CONSUMO_MIN', amount: price.negated() },
          { account: `model:${call.modelUserId}`, entryType: 'GANHO_MIN', amount: modelShare },
          { account: 'platform', entryType: 'COMISSAO', amount: commission },
        ],
        tx,
      );
      return { charged: true };
    });
  }

  private async lock(tx: Prisma.TransactionClient, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
}
```

Create `src/billing/billing.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { BillingService } from './billing.service';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule, UsersModule],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
```

Modify `src/app.module.ts` — importar `BillingModule` (mantendo todos os imports existentes).

- [ ] **Step 4: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/billing.charge-minute.spec.ts
npx tsc --noEmit
```
Expected: PASS (7 testes, incluindo o de serialização) e tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/billing/billing.service.ts src/billing/billing.module.ts src/app.module.ts test/billing.charge-minute.spec.ts
git commit -m "feat(billing): chargeMinute (per-client lock, idempotent, charges split or ends call on NO_CREDITS)"
```

---

### Task 4: BillingService.sendGift + GiftsController + suíte completa

**Files:**
- Modify: `src/billing/billing.service.ts`
- Create: `src/billing/gifts.controller.ts`
- Modify: `src/billing/billing.module.ts`
- Test: `test/gifts.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3 (`BillingService`, `lock`, `globalTakeRate`).
- Produces:
  - `BillingService.sendGift(clientId, modelId, giftTypeId): Promise<Gift>` — lock cliente; gift ativo + modelo MODEL (senão 404); saldo ≥ preço (senão 402); split soma-zero; cria `Gift`.
  - `BillingService.listGiftCatalog(): Promise<GiftType[]>` — ativos.
  - `GET /gifts/catalog` (autenticado), `POST /gifts { modelId, giftTypeId }` (`@Roles('CLIENT')`).

- [ ] **Step 1: Escrever o teste e2e**

Create `test/gifts.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Gifts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let fakeId: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.gift.deleteMany();
    await prisma.giftType.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function credit(clientId: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${clientId}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('catálogo lista só os ativos', async () => {
    await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    await prisma.giftType.create({ data: { name: 'Velha', priceCredits: new Prisma.Decimal('1.00'), active: false } });
    const c = await login('c0', 'CLIENT');
    const res = await http().get('/gifts/catalog').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Rosa');
  });

  it('cliente manda gift (split soma-zero) mesmo com modelo OFFLINE', async () => {
    const model = await login('m1', 'MODEL'); // sem presença/perfil → offline
    const gt = await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    const client = await login('c1', 'CLIENT');
    await credit(client.id, '20.00');
    const res = await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: model.id, giftTypeId: gt.id }).expect(201);
    expect(res.body.priceSnapshot).toBe('10');
    expect(await bal(`client:${client.id}`)).toBe('10');
    expect(await bal(`model:${model.id}`)).toBe('6'); // 10 - 40% = 6
    expect(await bal('platform')).toBe('4');
  });

  it('saldo insuficiente → 402', async () => {
    const model = await login('m2', 'MODEL');
    const gt = await prisma.giftType.create({ data: { name: 'Rosa', priceCredits: new Prisma.Decimal('10.00') } });
    const client = await login('c2', 'CLIENT');
    await credit(client.id, '5.00');
    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: model.id, giftTypeId: gt.id }).expect(402);
  });

  it('gift inexistente/inativo ou modelo não-MODEL → 404', async () => {
    const client = await login('c3', 'CLIENT');
    await credit(client.id, '20.00');
    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: client.id, giftTypeId: '00000000-0000-0000-0000-000000000000' }).expect(404);
  });

  it('MODEL no POST /gifts → 403', async () => {
    const model = await login('m4', 'MODEL');
    await http().post('/gifts').set('Authorization', `Bearer ${model.token}`).send({ modelId: 'x', giftTypeId: 'y' }).expect(403);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/gifts.e2e-spec.ts`
Expected: FAIL — rotas `/gifts` inexistentes.

- [ ] **Step 3: Adicionar sendGift + listGiftCatalog ao BillingService**

Modify `src/billing/billing.service.ts` — adicionar ao import do topo `HttpException`, `HttpStatus`, `NotFoundException`:
```typescript
import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Gift, GiftType, Prisma } from '@prisma/client';
```
e os métodos na classe (após `chargeMinute`):
```typescript
  async sendGift(clientId: string, modelId: string, giftTypeId: string): Promise<Gift> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, `call-client:${clientId}`);
      const giftType = await tx.giftType.findUnique({ where: { id: giftTypeId } });
      if (!giftType || !giftType.active) {
        throw new NotFoundException('gift not found');
      }
      const model = await tx.user.findUnique({ where: { id: modelId } });
      if (!model || model.role !== 'MODEL') {
        throw new NotFoundException('model not found');
      }
      const price = giftType.priceCredits;
      const balance = await this.ledger.getBalance(`client:${clientId}`, tx);
      if (balance.lessThan(price)) {
        throw new HttpException('insufficient balance', HttpStatus.PAYMENT_REQUIRED);
      }
      const profile = await tx.modelProfile.findUnique({ where: { userId: modelId } });
      const takeRate = resolveTakeRate(profile?.takeRate ?? null, this.globalTakeRate);
      const { commission, modelShare } = computeSplit(price, takeRate);
      const gift = await tx.gift.create({
        data: { clientUserId: clientId, modelUserId: modelId, giftTypeId, priceSnapshot: price },
      });
      await this.ledger.postTransaction(
        `gift:${gift.id}`,
        [
          { account: `client:${clientId}`, entryType: 'PRESENTE', amount: price.negated() },
          { account: `model:${modelId}`, entryType: 'GANHO_PRESENTE', amount: modelShare },
          { account: 'platform', entryType: 'COMISSAO', amount: commission },
        ],
        tx,
      );
      return gift;
    });
  }

  listGiftCatalog(): Promise<GiftType[]> {
    return this.prisma.giftType.findMany({ where: { active: true } });
  }
```

- [ ] **Step 4: Criar o GiftsController + registrar**

Create `src/billing/gifts.controller.ts`:
```typescript
import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { BillingService } from './billing.service';

interface SendGiftDto {
  modelId: string;
  giftTypeId: string;
}

@Controller('gifts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GiftsController {
  constructor(private readonly billing: BillingService) {}

  @Get('catalog')
  async catalog(): Promise<unknown> {
    return this.billing.listGiftCatalog();
  }

  @Post()
  @Roles('CLIENT')
  async send(@Req() req: Request & { user: AuthUser }, @Body() dto: SendGiftDto): Promise<unknown> {
    return this.billing.sendGift(req.user.id, dto.modelId, dto.giftTypeId);
  }
}
```

Modify `src/billing/billing.module.ts` — adicionar `GiftsController` aos `controllers`:
```typescript
import { GiftsController } from './gifts.controller';
// ...
  controllers: [GiftsController],
```

- [ ] **Step 5: Rodar a suíte completa e o tsc**

Run:
```bash
npm run test:int
npx tsc --noEmit
```
Expected: PASS — todas as suítes (incl. billing + gifts). tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/billing/billing.service.ts src/billing/gifts.controller.ts src/billing/billing.module.ts test/gifts.e2e-spec.ts
git commit -m "feat(billing): sendGift (per-client lock, sum-zero split) + GET /gifts/catalog + POST /gifts"
```

---

## Cobertura do spec (self-review)

| Requisito do spec (seção) | Onde é atendido |
|---|---|
| ModelProfile.takeRate + GiftType + Gift (§4) | Task 1 |
| GLOBAL_TAKE_RATE env fail-fast (§3) | Task 1 (env) + Task 3 (construtor lança) |
| Split rounding-safe soma-zero (§3) | Task 2 (`computeSplit`) + testes |
| resolveTakeRate global+override (§2,§3) | Task 2 + Task 3/4 (uso) |
| chargeMinute: lock, idempotência, cobra/encerra (§6.1) | Task 3 |
| Pré-pago + encerra NO_CREDITS inline (§3,§6.1) | Task 3 (`updateMany` ENDED) + teste |
| Idempotência por transactionGroup (§3) | Task 3 (pré-checagem) + teste |
| Serialização por cliente `call-client:<id>` (§2,§3) | Tasks 3,4 (`lock`) + teste concorrência |
| sendGift split + Gift + offline (§6.2) | Task 4 + testes |
| 402/404/403 do gift (§7) | Task 4 + testes |
| GET /gifts/catalog ativos (§6.3) | Task 4 |
| Billing não importa CallsModule (§5) | Tasks 3,4 (encerra via tx.call inline) |
| Migração não-interativa (§3) | Task 1 |
| tsc/import type (§3) | Tasks 2-4 |

Sem placeholders. Tipos consistentes entre tasks: `computeSplit`/`resolveTakeRate`, `BillingService.chargeMinute`/`sendGift`/`listGiftCatalog`, `ChargeResult`, `lock`/`globalTakeRate` usados igual onde produzidos e consumidos.
