# Cash-in PIX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o cliente crie uma recarga PIX (recebendo um QR) e que o webhook concilie o pagamento creditando o valor persistido — fechando a entrada de saldo.

**Architecture:** Fluxo create-first: `POST /wallet/recharge` persiste um `Recharge` PENDING e pede ao `PspChargePort` um QR; o webhook `POST /webhooks/psp` casa `paymentId` com `Recharge.pspChargeId` e credita `recharge.amount` (idempotente, mesma transação do CAS de status). Padrão port + fake (dev/test) + stub real (default de produção).

**Tech Stack:** NestJS 11, Prisma 5.22, Postgres, Jest (integração contra Postgres real), supertest.

## Global Constraints

- O webhook credita **`recharge.amount`** (persistido), nunca `event.amount`; `event.amount` só detecta divergência (mismatch → não credita).
- Crédito **idempotente**: dois `payment.confirmed` pro mesmo charge creditam uma vez só — CAS `updateMany({where:{id,status:'PENDING'}})` + grupo `recharge:<rechargeId>` no ledger, na mesma `$transaction`.
- App boota sem o PSP de charge; `RealPspChargeAdapter.createCharge` lança `Error('PSP charge not configured')` só quando usado. **Nenhum `Fake*` é default de produção.**
- `createRecharge` valida amount: decimal positivo com ≤2 casas e `>= MIN_RECHARGE` → senão `400`. Falha do PSP → `Recharge` vira `FAILED` + `503`.
- `POST /wallet/recharge` exige `@Roles('CLIENT')`; `GET /wallet/recharge/:id` só retorna a recarga do próprio usuário (senão `404`).
- Crédito soma-zero: `RECARGA` (+) em `client:<userId>` e `RECARGA_OFFSET` (−) em `source:external`.
- Webhook mantém HMAC + validação de payload existentes; `event.userId` não credita (usa `recharge.userId`).
- `import type` em interfaces injetadas. `npx tsc --noEmit` limpo. Migração UTF-8 sem BOM.

---

## File Structure

```
prisma/schema.prisma                         + model Recharge                          [mod]
prisma/migrations/20260626010000_recharge/migration.sql  CREATE TABLE recharges        [novo]
src/wallet/psp-charge.port.ts                PspChargePort + PSP_CHARGE_PORT + tipos    [novo]
src/wallet/fake-psp-charge.adapter.ts        QR determinístico (dev/test)             [novo]
src/wallet/real-psp-charge.adapter.ts        stub que lança (default de produção)     [novo]
src/wallet/wallet.service.ts                 createRecharge + confirmRecharge;         [mod]
                                             remove creditRecharge
src/wallet/recharge.controller.ts            POST /wallet/recharge, GET /:id           [novo]
src/wallet/wallet.controller.ts              webhook chama confirmRecharge             [mod]
src/wallet/wallet.module.ts                  + PrismaModule, AuthModule, port, ctrl    [mod]
.env.example                                 MIN_RECHARGE                              [mod]
test/wallet.recharge.spec.ts                 createRecharge + confirmRecharge + endpoint [mod]
test/wallet.webhook.e2e-spec.ts              crédito via create-first; HMAC mantido   [mod]
```

Ambiente: Docker UP (Postgres dev 5432, teste 5433, Redis 6379), schema de teste sincronizado. Integração: `npx jest --config ./jest-integration.json --runInBand <arquivo>`. `npm run db:test:push` sincroniza o DB de teste a partir do schema.

Padrões do projeto: auth por `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('CLIENT')`, usuário em `req.user.id` (tipo `AuthUser` de `../auth/jwt-auth.guard`). Default de produção de porta externa = adaptador real (stub que lança), fake só via `.overrideProvider`.

---

## Task 1: Model `Recharge` + migração

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260626010000_recharge/migration.sql`

**Interfaces:**
- Produces: tabela `recharges` e model Prisma `Recharge { id, userId, amount: Decimal, status: string, pspChargeId: string|null, qrText: string|null, expiresAt: Date|null, createdAt: Date, paidAt: Date|null }`.

- [ ] **Step 1: Adicionar o model ao schema**

In `prisma/schema.prisma`, add this model (após o model `Call`, antes de `GiftType`):

```prisma
model Recharge {
  id          String    @id @default(uuid())
  userId      String
  amount      Decimal   @db.Decimal(14, 2)
  status      String    @default("PENDING")
  pspChargeId String?
  qrText      String?
  expiresAt   DateTime?
  createdAt   DateTime  @default(now())
  paidAt      DateTime?

  @@index([pspChargeId])
  @@index([userId])
  @@map("recharges")
}
```

- [ ] **Step 2: Criar o arquivo de migração**

Create `prisma/migrations/20260626010000_recharge/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "recharges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pspChargeId" TEXT,
    "qrText" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "recharges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recharges_pspChargeId_idx" ON "recharges"("pspChargeId");

-- CreateIndex
CREATE INDEX "recharges_userId_idx" ON "recharges"("userId");
```

- [ ] **Step 3: Regenerar o client e sincronizar o DB de teste**

Run:
```
npx prisma generate
npm run db:test:push
```
Expected: `generate` cria o client com `Recharge`; `db push` reporta o DB de teste em sync (tabela criada).

- [ ] **Step 4: Verificar tsc e que a suíte de wallet ainda compila**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260626010000_recharge
git commit -m "feat(wallet): model Recharge (recarga PIX persistida)"
```

---

## Task 2: `PspChargePort` + adaptadores (fake + real-stub)

**Files:**
- Create: `src/wallet/psp-charge.port.ts`
- Create: `src/wallet/fake-psp-charge.adapter.ts`
- Create: `src/wallet/real-psp-charge.adapter.ts`
- Test: `test/wallet.recharge.spec.ts` (apenas o teste unit do real-stub neste task)

**Interfaces:**
- Produces:
  - `PSP_CHARGE_PORT` (string token), `PspChargeInput { rechargeId: string; amount: string; payerUserId: string }`, `PspCharge { pspChargeId: string; qrText: string; expiresAt: Date }`, `PspChargePort { createCharge(input: PspChargeInput): Promise<PspCharge> }`.
  - `FakePspChargeAdapter implements PspChargePort` (QR determinístico).
  - `RealPspChargeAdapter implements PspChargePort` (lança `Error('PSP charge not configured')`).

- [ ] **Step 1: Escrever o teste do real-stub que falha**

Create `test/wallet.recharge.spec.ts` with this initial content (more tests are added in Task 4):

```ts
import { RealPspChargeAdapter } from '../src/wallet/real-psp-charge.adapter';
import { FakePspChargeAdapter } from '../src/wallet/fake-psp-charge.adapter';

describe('PSP charge adapters', () => {
  it('RealPspChargeAdapter lança "not configured" até plugar um provedor', async () => {
    const real = new RealPspChargeAdapter();
    await expect(
      real.createCharge({ rechargeId: 'r1', amount: '50.00', payerUserId: 'u1' }),
    ).rejects.toThrow(/not configured/i);
  });

  it('FakePspChargeAdapter devolve um QR determinístico com expiração futura', async () => {
    const fake = new FakePspChargeAdapter();
    const out = await fake.createCharge({ rechargeId: 'r1', amount: '50.00', payerUserId: 'u1' });
    expect(out.pspChargeId).toContain('r1');
    expect(typeof out.qrText).toBe('string');
    expect(out.qrText.length).toBeGreaterThan(0);
    expect(out.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge.spec.ts`
Expected: FAIL — módulos `real-psp-charge.adapter` / `fake-psp-charge.adapter` inexistentes.

- [ ] **Step 3: Criar a porta**

Create `src/wallet/psp-charge.port.ts`:

```ts
export const PSP_CHARGE_PORT = 'PSP_CHARGE_PORT';

export interface PspChargeInput {
  rechargeId: string;
  amount: string;
  payerUserId: string;
}

export interface PspCharge {
  pspChargeId: string;
  qrText: string;
  expiresAt: Date;
}

export interface PspChargePort {
  createCharge(input: PspChargeInput): Promise<PspCharge>;
}
```

- [ ] **Step 4: Criar o fake**

Create `src/wallet/fake-psp-charge.adapter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { PspChargePort, PspChargeInput, PspCharge } from './psp-charge.port';

@Injectable()
export class FakePspChargeAdapter implements PspChargePort {
  async createCharge(input: PspChargeInput): Promise<PspCharge> {
    return {
      pspChargeId: `fake-charge:${input.rechargeId}`,
      qrText: `00020126FAKE-PIX-${input.rechargeId}-${input.amount}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }
}
```

- [ ] **Step 5: Criar o real-stub**

Create `src/wallet/real-psp-charge.adapter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { PspChargePort, PspChargeInput, PspCharge } from './psp-charge.port';

// Ponto-de-plugar do PSP de cobrança (cash-in PIX). Enquanto não houver provedor
// configurado, lança erro claro — nunca finge criar cobrança.
@Injectable()
export class RealPspChargeAdapter implements PspChargePort {
  async createCharge(_input: PspChargeInput): Promise<PspCharge> {
    throw new Error('PSP charge not configured');
  }
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge.spec.ts`
Expected: PASS (2/2).

- [ ] **Step 7: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add src/wallet/psp-charge.port.ts src/wallet/fake-psp-charge.adapter.ts src/wallet/real-psp-charge.adapter.ts test/wallet.recharge.spec.ts
git commit -m "feat(wallet): PspChargePort + fake (dev/test) + real-stub (default produção)"
```

---

## Task 3: `createRecharge` + `RechargeController` + wiring do módulo

**Files:**
- Modify: `src/wallet/wallet.service.ts` (adiciona `createRecharge`; mantém `creditRecharge` por ora — removido no Task 5)
- Create: `src/wallet/recharge.controller.ts`
- Modify: `src/wallet/wallet.module.ts`
- Modify: `.env.example`
- Test: `test/wallet.recharge.spec.ts`

**Interfaces:**
- Consumes: `PSP_CHARGE_PORT`/`PspChargePort` (Task 2); `PrismaService`; `Recharge` (Task 1).
- Produces: `WalletService.createRecharge(userId: string, amount: Prisma.Decimal): Promise<{ id: string; amount: string; status: string; qrText: string | null; expiresAt: Date | null }>`; rotas `POST /wallet/recharge` e `GET /wallet/recharge/:id`.

- [ ] **Step 1: Escrever os testes que falham**

Append these tests to `test/wallet.recharge.spec.ts` (a new `describe` block). They boot the app and override the PSP charge port with the fake (and a failing fake for the FAILED case):

```ts
import { Test } from '@nestjs/testing';
import { INestApplication, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { WalletService } from '../src/wallet/wallet.service';
import { TokenService } from '../src/auth/token.service';
import { PSP_CHARGE_PORT } from '../src/wallet/psp-charge.port';
import type { PspChargePort, PspChargeInput, PspCharge } from '../src/wallet/psp-charge.port';

@Injectable()
class ThrowingPspCharge implements PspChargePort {
  async createCharge(_i: PspChargeInput): Promise<PspCharge> {
    throw new Error('boom');
  }
}

describe('createRecharge + RechargeController', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wallet: WalletService;
  let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    wallet = mod.get(WalletService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.recharge.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function makeUser(role: 'CLIENT' | 'MODEL'): Promise<{ id: string; access: string }> {
    const u = await prisma.user.create({ data: { id: `u-${Math.random().toString(36).slice(2)}`, role, provider: 'google', providerSubject: `s-${Math.random()}`, email: `${Math.random()}@x.com`, displayName: 'U', status: 'ACTIVE' } });
    const access = tokens.signAccess({ id: u.id, role });
    return { id: u.id, access };
  }

  it('createRecharge persiste PENDING e devolve o QR (fake)', async () => {
    const { id } = await makeUser('CLIENT');
    const out = await wallet.createRecharge(id, new Prisma.Decimal('50.00'));
    expect(out.status).toBe('PENDING');
    expect(out.qrText).toContain(out.id);
    const row = await prisma.recharge.findUnique({ where: { id: out.id } });
    expect(row?.pspChargeId).toBe(`fake-charge:${out.id}`);
    expect(row?.expiresAt).not.toBeNull();
  });

  it('rejeita amount abaixo do mínimo com 400', async () => {
    const { id } = await makeUser('CLIENT');
    await expect(wallet.createRecharge(id, new Prisma.Decimal('1.00'))).rejects.toMatchObject({ status: 400 });
  });

  it('POST /wallet/recharge exige role CLIENT (403 para MODEL)', async () => {
    const { access } = await makeUser('MODEL');
    await request(app.getHttpServer())
      .post('/wallet/recharge')
      .set('authorization', `Bearer ${access}`)
      .send({ amount: '50.00' })
      .expect(403);
  });

  it('POST /wallet/recharge cria e GET /:id devolve ao dono; 404 para outro usuário', async () => {
    const client = await makeUser('CLIENT');
    const other = await makeUser('CLIENT');
    const res = await request(app.getHttpServer())
      .post('/wallet/recharge')
      .set('authorization', `Bearer ${client.access}`)
      .send({ amount: '50.00' })
      .expect(201);
    const id = res.body.id as string;
    await request(app.getHttpServer())
      .get(`/wallet/recharge/${id}`)
      .set('authorization', `Bearer ${client.access}`)
      .expect(200)
      .expect((r) => { expect(r.body.status).toBe('PENDING'); });
    await request(app.getHttpServer())
      .get(`/wallet/recharge/${id}`)
      .set('authorization', `Bearer ${other.access}`)
      .expect(404);
  });

  it('PSP indisponível marca a recarga FAILED e responde 503', async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PSP_CHARGE_PORT)
      .useClass(ThrowingPspCharge)
      .compile();
    const app2 = mod.createNestApplication({ rawBody: true });
    await app2.init();
    const p2 = app2.get(PrismaService);
    const w2 = app2.get(WalletService);
    await p2.recharge.deleteMany();
    const u = await p2.user.create({ data: { id: `u-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: `${Math.random()}@x.com`, displayName: 'U', status: 'ACTIVE' } });
    await expect(w2.createRecharge(u.id, new Prisma.Decimal('50.00'))).rejects.toMatchObject({ status: 503 });
    const rows = await p2.recharge.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('FAILED');
    await app2.close();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge.spec.ts`
Expected: FAIL — `WalletService.createRecharge` e `RechargeController` não existem; `POST /wallet/recharge` → 404.

> Nota: `tokens.signAccess({ id, role })` é a API real (síncrona, retorna string) — confirmado em `src/auth/token.service.ts`. O `makeUser` cria o usuário ACTIVE no banco, então o `JwtAuthGuard` (que relê o status do DB) aceita o token. Não precisa de override do IDENTITY_PROVIDER neste fluxo (não passa por `/auth/google`).

- [ ] **Step 3: Adicionar `createRecharge` ao WalletService**

In `src/wallet/wallet.service.ts`, add the imports and the method. The file currently imports `BadRequestException, Injectable` from `@nestjs/common`, `Prisma` from `@prisma/client`, and `LedgerService`. Update to:

```ts
import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PSP_CHARGE_PORT } from './psp-charge.port';
import type { PspChargePort } from './psp-charge.port';
```

Update the constructor to inject Prisma and the port (keep `ledger`):

```ts
  constructor(
    private readonly ledger: LedgerService,
    private readonly prisma: PrismaService,
    @Inject(PSP_CHARGE_PORT) private readonly pspCharge: PspChargePort,
  ) {}
```

Add the method (keep the existing `creditRecharge` for now):

```ts
  async createRecharge(
    userId: string,
    amount: Prisma.Decimal,
  ): Promise<{ id: string; amount: string; status: string; qrText: string | null; expiresAt: Date | null }> {
    const min = new Prisma.Decimal(process.env.MIN_RECHARGE ?? '5.00');
    if (amount.decimalPlaces() > 2 || !amount.greaterThanOrEqualTo(min)) {
      throw new BadRequestException(`amount must be a positive value of at least ${min.toString()}`);
    }
    const recharge = await this.prisma.recharge.create({
      data: { userId, amount, status: 'PENDING' },
    });
    try {
      const charge = await this.pspCharge.createCharge({
        rechargeId: recharge.id,
        amount: amount.toString(),
        payerUserId: userId,
      });
      const updated = await this.prisma.recharge.update({
        where: { id: recharge.id },
        data: { pspChargeId: charge.pspChargeId, qrText: charge.qrText, expiresAt: charge.expiresAt },
      });
      return {
        id: updated.id,
        amount: updated.amount.toString(),
        status: updated.status,
        qrText: updated.qrText,
        expiresAt: updated.expiresAt,
      };
    } catch {
      await this.prisma.recharge.update({ where: { id: recharge.id }, data: { status: 'FAILED' } });
      throw new ServiceUnavailableException('payment provider unavailable');
    }
  }
```

- [ ] **Step 4: Criar o RechargeController**

Create `src/wallet/recharge.controller.ts`:

```ts
import { Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from './wallet.service';

interface CreateRechargeDto {
  amount: string;
}

@Controller('wallet/recharge')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RechargeController {
  constructor(
    private readonly wallet: WalletService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles('CLIENT')
  async create(@Req() req: Request & { user: AuthUser }, @Body() dto: CreateRechargeDto): Promise<unknown> {
    return this.wallet.createRecharge(req.user.id, new Prisma.Decimal(dto.amount));
  }

  @Get(':id')
  async get(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    const r = await this.prisma.recharge.findUnique({ where: { id } });
    if (!r || r.userId !== req.user.id) {
      throw new NotFoundException('recharge not found');
    }
    return { id: r.id, amount: r.amount.toString(), status: r.status, qrText: r.qrText, expiresAt: r.expiresAt, paidAt: r.paidAt };
  }
}
```

- [ ] **Step 5: Religar o WalletModule**

Replace the entire contents of `src/wallet/wallet.module.ts` with:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { RechargeController } from './recharge.controller';
import { PspSignatureValidator } from './psp-signature.validator';
import { PSP_CHARGE_PORT } from './psp-charge.port';
import { RealPspChargeAdapter } from './real-psp-charge.adapter';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule],
  controllers: [WalletController, RechargeController],
  providers: [
    WalletService,
    { provide: PSP_CHARGE_PORT, useClass: RealPspChargeAdapter },
    {
      provide: PspSignatureValidator,
      useFactory: (): PspSignatureValidator => {
        const secret = process.env.PSP_WEBHOOK_SECRET;
        if (!secret) {
          throw new Error('PSP_WEBHOOK_SECRET env var is required');
        }
        return new PspSignatureValidator(secret);
      },
    },
  ],
  exports: [WalletService],
})
export class WalletModule {}
```

- [ ] **Step 6: Documentar MIN_RECHARGE no `.env.example`**

In `.env.example`, in the "Opcionais / com default" section (após `MIN_PAYOUT="200"`), add:

```bash
MIN_RECHARGE="5.00"                 # valor mínimo de uma recarga PIX
```

- [ ] **Step 7: Atualizar os testes do real-stub para usar o fake como default em dev**

The Task 3 tests boot `AppModule`, whose `WalletModule` now defaults `PSP_CHARGE_PORT` to `RealPspChargeAdapter` (which throws). For the success-path tests to work, the booted AppModule must use the fake. Update the `createRecharge + RechargeController` describe block's `beforeAll` to override the port with the fake:

```ts
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PSP_CHARGE_PORT)
      .useClass(FakePspChargeAdapter)
      .compile();
```

Add the import at the top of the file if missing: `import { FakePspChargeAdapter } from '../src/wallet/fake-psp-charge.adapter';`. (The `PSP indisponível` test keeps its own module with `ThrowingPspCharge`.)

- [ ] **Step 8: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge.spec.ts`
Expected: PASS (todos — adapters 2 + createRecharge/endpoint 5).

- [ ] **Step 9: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add src/wallet/wallet.service.ts src/wallet/recharge.controller.ts src/wallet/wallet.module.ts .env.example test/wallet.recharge.spec.ts
git commit -m "feat(wallet): createRecharge + POST/GET /wallet/recharge (create-first, fake/real port)"
```

---

## Task 4: `confirmRecharge` + webhook reconciliado

**Files:**
- Modify: `src/wallet/wallet.service.ts` (adiciona `confirmRecharge`; remove `creditRecharge`)
- Modify: `src/wallet/wallet.controller.ts` (webhook chama `confirmRecharge`)
- Test: `test/wallet.recharge.spec.ts` (testes de `confirmRecharge`), `test/wallet.webhook.e2e-spec.ts` (create-first)

**Interfaces:**
- Consumes: `Recharge`, `LedgerService.postTransaction(group, entries, tx)`.
- Produces: `WalletService.confirmRecharge(pspChargeId: string, eventAmount: Prisma.Decimal): Promise<{ credited: boolean; reason?: 'unknown' | 'already' | 'amount_mismatch' }>`.

- [ ] **Step 1: Escrever os testes de confirmRecharge que falham**

First ensure the file imports `LedgerService` at the top (add if missing):
`import { LedgerService } from '../src/ledger/ledger.service';`

Then append a new `describe` block to `test/wallet.recharge.spec.ts`:

```ts
describe('confirmRecharge', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let wallet: WalletService;
  let ledger: LedgerService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    wallet = mod.get(WalletService);
    ledger = mod.get(LedgerService);
  });
  beforeEach(async () => {
    await prisma.recharge.deleteMany();
    await prisma.ledgerEntry.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function pending(userId: string, amount: string, pspChargeId: string): Promise<string> {
    const r = await prisma.recharge.create({ data: { userId, amount: new Prisma.Decimal(amount), status: 'PENDING', pspChargeId } });
    return r.id;
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('credita o valor persistido e marca PAID; idempotente', async () => {
    const id = await pending('u1', '150.00', 'pix_42');
    const r1 = await wallet.confirmRecharge('pix_42', new Prisma.Decimal('150.00'));
    expect(r1.credited).toBe(true);
    expect(await bal('client:u1')).toBe('150');
    const row = await prisma.recharge.findUnique({ where: { id } });
    expect(row?.status).toBe('PAID');
    const r2 = await wallet.confirmRecharge('pix_42', new Prisma.Decimal('150.00'));
    expect(r2.credited).toBe(false);
    expect(r2.reason).toBe('already');
    expect(await bal('client:u1')).toBe('150');
  });

  it('paymentId desconhecido não credita', async () => {
    const r = await wallet.confirmRecharge('nope', new Prisma.Decimal('10.00'));
    expect(r.credited).toBe(false);
    expect(r.reason).toBe('unknown');
  });

  it('valor divergente não credita e mantém PENDING', async () => {
    const id = await pending('u2', '100.00', 'pix_77');
    const r = await wallet.confirmRecharge('pix_77', new Prisma.Decimal('999.00'));
    expect(r.credited).toBe(false);
    expect(r.reason).toBe('amount_mismatch');
    expect(await bal('client:u2')).toBe('0');
    const row = await prisma.recharge.findUnique({ where: { id } });
    expect(row?.status).toBe('PENDING');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge.spec.ts -t confirmRecharge`
Expected: FAIL — `confirmRecharge` não existe.

- [ ] **Step 3: Implementar `confirmRecharge` e remover `creditRecharge`**

In `src/wallet/wallet.service.ts`, REMOVE the old `creditRecharge` method entirely and add:

```ts
  async confirmRecharge(
    pspChargeId: string,
    eventAmount: Prisma.Decimal,
  ): Promise<{ credited: boolean; reason?: 'unknown' | 'already' | 'amount_mismatch' }> {
    return this.prisma.$transaction(async (tx) => {
      const recharge = await tx.recharge.findFirst({ where: { pspChargeId } });
      if (!recharge) {
        return { credited: false, reason: 'unknown' as const };
      }
      if (recharge.status === 'PAID') {
        return { credited: false, reason: 'already' as const };
      }
      if (!eventAmount.equals(recharge.amount)) {
        return { credited: false, reason: 'amount_mismatch' as const };
      }
      const claimed = await tx.recharge.updateMany({
        where: { id: recharge.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: new Date() },
      });
      if (claimed.count !== 1) {
        return { credited: false, reason: 'already' as const };
      }
      await this.ledger.postTransaction(
        `recharge:${recharge.id}`,
        [
          { account: `client:${recharge.userId}`, entryType: 'RECARGA', amount: recharge.amount },
          { account: 'source:external', entryType: 'RECARGA_OFFSET', amount: recharge.amount.negated() },
        ],
        tx,
      );
      return { credited: true };
    });
  }
```

- [ ] **Step 4: Apontar o webhook para `confirmRecharge`**

In `src/wallet/wallet.controller.ts`, replace the crediting call. The current code ends with:

```ts
    await this.wallet.creditRecharge(
      event.paymentId,
      `client:${event.userId}`,
      new Prisma.Decimal(event.amount),
    );
    return { received: true };
```

Replace those lines with:

```ts
    await this.wallet.confirmRecharge(event.paymentId, new Prisma.Decimal(event.amount));
    return { received: true };
```

(Keep all the HMAC + payload validation above it exactly as-is.)

- [ ] **Step 5: Rodar os testes de confirmRecharge e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge.spec.ts`
Expected: PASS (todos os describes do arquivo).

- [ ] **Step 6: Atualizar o e2e do webhook para create-first**

Replace the two crediting tests in `test/wallet.webhook.e2e-spec.ts` so they create a `Recharge` first. Add `PrismaService` is already imported. Replace the test `'credita o cliente em evento payment.confirmed assinado'` (lines ~31-45) and `'ainda credita com 200 num evento válido após validação'` (lines ~83-86) with:

```ts
  it('credita o cliente (create-first) em payment.confirmed assinado', async () => {
    await prisma.recharge.create({ data: { userId: '7', amount: new (require('@prisma/client').Prisma.Decimal)('150.00'), status: 'PENDING', pspChargeId: 'pix_42' } });
    const { body, sig } = sign({ event: 'payment.confirmed', paymentId: 'pix_42', userId: '7', amount: '150.00' });
    await request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', sig)
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect((await ledger.getBalance('client:7')).toString()).toBe('150');
  });

  it('não credita sem Recharge correspondente (órfão), mas responde 200', async () => {
    await postSigned({ event: 'payment.confirmed', paymentId: 'pix_orphan', userId: '9', amount: '25.00' }).expect(200);
    expect((await ledger.getBalance('client:9')).toString()).toBe('0');
  });
```

Also update the `beforeEach` to clear recharges:

```ts
  beforeEach(async () => { await prisma.recharge.deleteMany(); await prisma.ledgerEntry.deleteMany(); });
```

Leave the HMAC (401), the 400 validation tests, and the non-`payment.confirmed` test unchanged.

- [ ] **Step 7: Rodar o e2e do webhook e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.webhook.e2e-spec.ts`
Expected: PASS (todos).

- [ ] **Step 8: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add src/wallet/wallet.service.ts src/wallet/wallet.controller.ts test/wallet.recharge.spec.ts test/wallet.webhook.e2e-spec.ts
git commit -m "feat(wallet): confirmRecharge credita valor persistido (idempotente); webhook reconciliado"
```

---

## Task 5: Verificação final

**Files:** nenhum (verificação).

- [ ] **Step 1: Rodar a suíte completa**

Run: `npm run test:int`
Expected: todas as suítes verdes (incl. wallet.recharge + wallet.webhook atualizadas). Os ERROR de detecção de reuso de refresh token são esperados.

- [ ] **Step 2: tsc final**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 3: Auditoria — nenhum `Fake*`/stub-fake é default de produção**

Run: `grep -rn "useClass:" src --include=*.module.ts`
Expected: `PSP_CHARGE_PORT` → `RealPspChargeAdapter`; os demais inalterados (todos reais/stubs, nenhum `Fake*`).

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review (autor)

**Cobertura do spec:**
- §5.1 model Recharge + migração → Task 1. ✓
- §5.2 PspChargePort + Fake + Real(stub) → Task 2. ✓
- §5.3 createRecharge (validação, FAILED em erro do PSP, MIN_RECHARGE) → Task 3. ✓
- §5.5 RechargeController POST(CLIENT)/GET(dono, 404 alheio) → Task 3. ✓
- §5.4 confirmRecharge (unknown/already/amount_mismatch/CAS/credita persistido) → Task 4. ✓
- §5.6 webhook chama confirmRecharge, HMAC/validação mantidos, event.userId não credita → Task 4. ✓
- §5.7 module wiring (PrismaModule, AuthModule, port Real default, RechargeController) → Task 3 Step 5. ✓
- §2/§3 nenhum Fake default + auditoria → Task 5 Step 3. ✓
- §7 testes (create/endpoint/auth/FAILED, confirm idempotente/órfão/mismatch, webhook create-first) → Tasks 2/3/4. ✓
- §1 remove creditRecharge → Task 4 Step 3. ✓

**Consistência de tipos:** `createRecharge(userId, amount: Decimal)` e `confirmRecharge(pspChargeId, eventAmount: Decimal)` idênticos em todas as tasks; `PspCharge {pspChargeId,qrText,expiresAt}`, `PspChargeInput {rechargeId,amount,payerUserId}`; `PSP_CHARGE_PORT` token; grupo idempotente `recharge:<rechargeId>`.

**Placeholders:** nenhum — código/comando concreto em cada passo. A única verificação aberta (assinatura real do `issueAccessToken`) está explicitada no Task 3 Step 2 com instrução de ajuste.

**Nota de escopo:** sweeper de expiração, histórico/listagem, HTTP real do provedor e estorno ficam fora (documentado no spec).
