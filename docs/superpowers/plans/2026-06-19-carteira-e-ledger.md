# Carteira & Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o coração financeiro da Samy — um livro-razão (ledger) de dupla entrada, append-only e idempotente, com cash-in via webhook de PSP e cash-out (saque) com fila de pagamento.

**Architecture:** NestJS expõe serviços de domínio (`LedgerService`, `WalletService`, `PayoutProcessor`) sobre PostgreSQL via Prisma. O ledger é a única fonte de verdade: nunca se edita saldo; o saldo de uma conta é `SUM(amount)` das suas transações imutáveis. Toda operação financeira é um conjunto de lançamentos que **soma zero** e carrega uma chave de idempotência. Integrações externas (PSP de entrada/saída, KYC) entram por **portas/interfaces** (padrão Strategy), com adaptadores reais simples agora e substituíveis depois.

**Tech Stack:** NestJS (TypeScript), PostgreSQL, Prisma ORM, Jest (testes de integração contra um Postgres de teste), Docker Compose (Postgres local), `crypto` nativo (HMAC para assinatura de webhook).

## Global Constraints

- **Append-only:** a tabela `ledger_entries` NUNCA recebe `UPDATE` ou `DELETE`. Correções são novos lançamentos de estorno.
- **Soma zero:** todo conjunto de lançamentos de uma transação soma exatamente `0`.
- **Idempotência obrigatória:** toda postagem carrega uma chave única; reprocessar é no-op.
- **Dinheiro é decimal, nunca float:** colunas `Decimal @db.Decimal(14, 2)`; em código, `Prisma.Decimal`. Proibido `number` para valores monetários em operações aritméticas.
- **Verdade no Postgres:** saldo = `SUM(amount)`. Cache em Redis fica adiado para quando o Billing Engine exigir leitura rápida (fora do escopo deste plano).
- **Conta `source:external`:** representa o mundo fora do sistema. Cash-in credita o cliente e debita `source:external` (mantendo soma zero); cash-out faz o inverso.
- **Take rate / split por minuto NÃO entra aqui:** o split da chamada (cliente −5 / modelo +3 / plataforma +2) é responsabilidade do Billing Engine. Este plano entrega o *primitivo* genérico `postTransaction` que o Billing usará.

---

### Task 1: Scaffolding do projeto (NestJS + Postgres + Prisma + Jest)

**Files:**
- Create: `package.json`, `tsconfig.json`, `nest-cli.json`, `.gitignore`
- Create: `docker-compose.yml`
- Create: `.env`, `.env.test`
- Create: `prisma/schema.prisma`
- Create: `src/main.ts`, `src/app.module.ts`
- Create: `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`
- Create: `test/setup.ts`, `jest-integration.json`
- Test: `test/smoke.spec.ts`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: `PrismaService` (extends `PrismaClient`, injetável); um Postgres de teste acessível via `DATABASE_URL` de `.env.test`; comando `npm run test:int` que aplica o schema e roda os specs de integração.

- [ ] **Step 1: Inicializar o projeto NestJS**

Run:
```bash
cd "c:/Users/arthu/OneDrive/Área de Trabalho/Samy"
git init
npx -y @nestjs/cli@latest new . --skip-git --package-manager npm
```
Quando perguntar, aceite sobrescrever nada que conflite com `docs/`. Isso cria `package.json`, `tsconfig.json`, `nest-cli.json`, `src/main.ts`, `src/app.module.ts` e configuração base do Jest.

- [ ] **Step 2: Instalar dependências de dados e teste**

Run:
```bash
npm install @prisma/client
npm install -D prisma
npx prisma init --datasource-provider postgresql
```

- [ ] **Step 3: Criar `docker-compose.yml` com Postgres (dev + test)**

Create `docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: samy
      POSTGRES_PASSWORD: samy
      POSTGRES_DB: samy
    volumes:
      - samy_pg:/var/lib/postgresql/data
  postgres_test:
    image: postgres:16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: samy
      POSTGRES_PASSWORD: samy
      POSTGRES_DB: samy_test
volumes:
  samy_pg:
```

Run:
```bash
docker compose up -d
```

- [ ] **Step 4: Configurar variáveis de ambiente**

Create `.env`:
```
DATABASE_URL="postgresql://samy:samy@localhost:5432/samy?schema=public"
PSP_WEBHOOK_SECRET="dev-webhook-secret"
MIN_PAYOUT="200.00"
```

Create `.env.test`:
```
DATABASE_URL="postgresql://samy:samy@localhost:5433/samy_test?schema=public"
PSP_WEBHOOK_SECRET="test-webhook-secret"
MIN_PAYOUT="200.00"
```

Add to `.gitignore` (append):
```
.env
.env.test
node_modules
dist
```

- [ ] **Step 5: Definir um schema Prisma mínimo (modelo placeholder removido na Task 2)**

Replace `prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model HealthCheck {
  id Int @id @default(autoincrement())

  @@map("health_check")
}
```

Run:
```bash
npx prisma migrate dev --name init
```
Expected: cria a migration e a tabela `health_check` no banco de dev.

- [ ] **Step 6: Criar `PrismaService` e `PrismaModule`**

Create `src/prisma/prisma.service.ts`:
```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

Create `src/prisma/prisma.module.ts`:
```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

Modify `src/app.module.ts` to import `PrismaModule`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule],
})
export class AppModule {}
```

- [ ] **Step 7: Configurar Jest de integração**

Create `jest-integration.json`:
```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testRegex": ".*\\.spec\\.ts$",
  "transform": { "^.+\\.(t|j)s$": "ts-jest" },
  "setupFiles": ["<rootDir>/test/setup.ts"],
  "testEnvironment": "node"
}
```

Create `test/setup.ts`:
```typescript
import { config } from 'dotenv';
config({ path: '.env.test' });
```

Add scripts to `package.json` (`scripts` block):
```json
"db:test:push": "dotenv -e .env.test -- prisma db push --skip-generate --accept-data-loss",
"test:int": "npm run db:test:push && jest --config ./jest-integration.json --runInBand"
```

Run:
```bash
npm install -D dotenv-cli ts-jest
```

- [ ] **Step 8: Escrever o smoke test de integração**

Create `test/smoke.spec.ts`:
```typescript
import { PrismaClient } from '@prisma/client';

describe('infra smoke', () => {
  const prisma = new PrismaClient();
  afterAll(async () => { await prisma.$disconnect(); });

  it('conecta no Postgres de teste e executa uma query', async () => {
    const result = await prisma.$queryRaw`SELECT 1 as ok`;
    expect(result).toEqual([{ ok: 1 }]);
  });
});
```

- [ ] **Step 9: Rodar para confirmar verde**

Run:
```bash
npm run test:int
```
Expected: PASS — 1 teste passando, conectando no banco `samy_test` (porta 5433).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: scaffold NestJS + Prisma + Postgres + integration testing"
```

---

### Task 2: Schema do ledger (LedgerEntry, Payout, KycStatus)

**Files:**
- Modify: `prisma/schema.prisma`
- Test: `test/ledger-schema.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient` (Task 1).
- Produces: tabelas `ledger_entries` (com `idempotencyRef` único), `payouts`, `kyc_status`. Tipos Prisma `LedgerEntry`, `Payout`, `KycStatus` disponíveis no client.

- [ ] **Step 1: Escrever o teste que falha (constraint de idempotência)**

Create `test/ledger-schema.spec.ts`:
```typescript
import { PrismaClient, Prisma } from '@prisma/client';

describe('ledger schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('rejeita idempotencyRef duplicado', async () => {
    const base = {
      account: 'client:1',
      entryType: 'RECARGA',
      amount: new Prisma.Decimal('100.00'),
      transactionGroup: 'g1',
      idempotencyRef: 'g1#0',
    };
    await prisma.ledgerEntry.create({ data: base });
    await expect(prisma.ledgerEntry.create({ data: base })).rejects.toMatchObject({ code: 'P2002' });
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run:
```bash
npm run test:int -- test/ledger-schema.spec.ts
```
Expected: FAIL — `prisma.ledgerEntry` não existe.

- [ ] **Step 3: Definir os modelos no schema**

Replace o modelo `HealthCheck` em `prisma/schema.prisma` por:
```prisma
model LedgerEntry {
  id               String   @id @default(uuid())
  account          String
  entryType        String
  amount           Decimal  @db.Decimal(14, 2)
  transactionGroup String
  idempotencyRef   String   @unique
  metadata         Json?
  createdAt        DateTime @default(now())

  @@index([account])
  @@map("ledger_entries")
}

model Payout {
  id          String    @id @default(uuid())
  account     String
  amount      Decimal   @db.Decimal(14, 2)
  status      String    @default("PENDING")
  pixKey      String
  createdAt   DateTime  @default(now())
  processedAt DateTime?

  @@index([status])
  @@map("payouts")
}

model KycStatus {
  account  String  @id
  approved Boolean @default(false)

  @@map("kyc_status")
}
```

- [ ] **Step 4: Gerar client e aplicar no banco de dev**

Run:
```bash
npx prisma migrate dev --name ledger_core
```
Expected: cria a migration `ledger_core` e regenera o client.

- [ ] **Step 5: Rodar o teste (aplica schema no banco de teste e valida)**

Run:
```bash
npm run test:int -- test/ledger-schema.spec.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ledger): add LedgerEntry, Payout, KycStatus schema"
```

---

### Task 3: LedgerService — postTransaction + getBalance

**Files:**
- Create: `src/ledger/ledger.types.ts`
- Create: `src/ledger/ledger.service.ts`
- Create: `src/ledger/ledger.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/ledger.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (Task 1).
- Produces:
  - `LedgerEntryInput = { account: string; entryType: string; amount: Prisma.Decimal; metadata?: Prisma.InputJsonValue }`
  - `LedgerService.postTransaction(groupRef: string, entries: LedgerEntryInput[], tx?: Prisma.TransactionClient): Promise<{ posted: boolean }>` — valida soma zero, insere atomicamente, idempotente por `groupRef`. `posted: false` quando já existia.
  - `LedgerService.getBalance(account: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal>`

- [ ] **Step 1: Escrever os testes que falham**

Create `test/ledger.service.spec.ts`:
```typescript
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
```

- [ ] **Step 2: Rodar para ver falhar**

Run:
```bash
npm run test:int -- test/ledger.service.spec.ts
```
Expected: FAIL — módulo `LedgerModule` inexistente.

- [ ] **Step 3: Criar os tipos**

Create `src/ledger/ledger.types.ts`:
```typescript
import { Prisma } from '@prisma/client';

export interface LedgerEntryInput {
  account: string;
  entryType: string;
  amount: Prisma.Decimal;
  metadata?: Prisma.InputJsonValue;
}
```

- [ ] **Step 4: Implementar o LedgerService**

Create `src/ledger/ledger.service.ts`:
```typescript
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

    try {
      if (tx) {
        await run(tx);
      } else {
        await this.prisma.$transaction(run);
      }
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
```

- [ ] **Step 5: Criar o módulo e registrá-lo**

Create `src/ledger/ledger.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
```

Modify `src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';

@Module({
  imports: [PrismaModule, LedgerModule],
})
export class AppModule {}
```

- [ ] **Step 6: Rodar os testes**

Run:
```bash
npm run test:int -- test/ledger.service.spec.ts
```
Expected: PASS — 4 testes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(ledger): postTransaction (sum-zero, idempotent) and getBalance"
```

---

### Task 4: WalletService.creditRecharge (cash-in idempotente)

**Files:**
- Create: `src/wallet/wallet.service.ts`
- Create: `src/wallet/wallet.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/wallet.recharge.spec.ts`

**Interfaces:**
- Consumes: `LedgerService.postTransaction` (Task 3).
- Produces: `WalletService.creditRecharge(pspPaymentId: string, account: string, amount: Prisma.Decimal): Promise<{ posted: boolean }>` — credita `account` e debita `source:external`, idempotente por `recharge:${pspPaymentId}`.

- [ ] **Step 1: Escrever o teste que falha**

Create `test/wallet.recharge.spec.ts`:
```typescript
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
```

- [ ] **Step 2: Rodar para ver falhar**

Run:
```bash
npm run test:int -- test/wallet.recharge.spec.ts
```
Expected: FAIL — `WalletModule` inexistente.

- [ ] **Step 3: Implementar o WalletService**

Create `src/wallet/wallet.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class WalletService {
  constructor(private readonly ledger: LedgerService) {}

  async creditRecharge(
    pspPaymentId: string,
    account: string,
    amount: Prisma.Decimal,
  ): Promise<{ posted: boolean }> {
    return this.ledger.postTransaction(`recharge:${pspPaymentId}`, [
      { account, entryType: 'RECARGA', amount },
      { account: 'source:external', entryType: 'RECARGA_OFFSET', amount: amount.negated() },
    ]);
  }
}
```

Create `src/wallet/wallet.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletService } from './wallet.service';

@Module({
  imports: [LedgerModule],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
```

Modify `src/app.module.ts` to add `WalletModule` to `imports`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [PrismaModule, LedgerModule, WalletModule],
})
export class AppModule {}
```

- [ ] **Step 4: Rodar os testes**

Run:
```bash
npm run test:int -- test/wallet.recharge.spec.ts
```
Expected: PASS — 2 testes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(wallet): idempotent creditRecharge (cash-in)"
```

---

### Task 5: Webhook de cash-in (validação de assinatura + controller)

**Files:**
- Create: `src/wallet/psp-signature.validator.ts`
- Create: `src/wallet/wallet.controller.ts`
- Modify: `src/wallet/wallet.module.ts`
- Modify: `src/main.ts` (habilitar rawBody)
- Test: `test/psp-signature.validator.spec.ts`
- Test: `test/wallet.webhook.e2e-spec.ts`

**Interfaces:**
- Consumes: `WalletService.creditRecharge` (Task 4).
- Produces:
  - `PspSignatureValidator.isValid(rawBody: Buffer, signature: string): boolean` — HMAC-SHA256 com `PSP_WEBHOOK_SECRET`, comparação tempo-constante.
  - `POST /webhooks/psp` — valida assinatura (header `x-psp-signature`), e em evento `payment.confirmed` chama `creditRecharge`. Retorna 200 `{ received: true }`; 401 se assinatura inválida.

- [ ] **Step 1: Escrever o teste do validador (unitário)**

Create `test/psp-signature.validator.spec.ts`:
```typescript
import { createHmac } from 'crypto';
import { PspSignatureValidator } from '../src/wallet/psp-signature.validator';

describe('PspSignatureValidator', () => {
  const secret = 'test-webhook-secret';
  const validator = new PspSignatureValidator(secret);

  it('aceita assinatura HMAC válida', () => {
    const body = Buffer.from(JSON.stringify({ event: 'payment.confirmed' }));
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(validator.isValid(body, sig)).toBe(true);
  });

  it('rejeita assinatura inválida', () => {
    const body = Buffer.from('{}');
    expect(validator.isValid(body, 'deadbeef')).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run:
```bash
npm run test:int -- test/psp-signature.validator.spec.ts
```
Expected: FAIL — classe inexistente.

- [ ] **Step 3: Implementar o validador**

Create `src/wallet/psp-signature.validator.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export const PSP_WEBHOOK_SECRET = 'PSP_WEBHOOK_SECRET';

@Injectable()
export class PspSignatureValidator {
  constructor(private readonly secret: string) {}

  isValid(rawBody: Buffer, signature: string): boolean {
    const expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) {
      return false;
    }
    return timingSafeEqual(a, b);
  }
}
```

- [ ] **Step 4: Rodar o teste do validador**

Run:
```bash
npm run test:int -- test/psp-signature.validator.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Escrever o teste e2e do webhook**

Create `test/wallet.webhook.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';

describe('POST /webhooks/psp', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  const secret = 'test-webhook-secret';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.init();
    prisma = moduleRef.get(PrismaService);
    ledger = moduleRef.get(LedgerService);
  });
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); });
  afterAll(async () => { await app.close(); });

  function sign(payload: object): { body: string; sig: string } {
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    return { body, sig };
  }

  it('credita o cliente em evento payment.confirmed assinado', async () => {
    const { body, sig } = sign({
      event: 'payment.confirmed',
      paymentId: 'pix_42',
      userId: '7',
      amount: '150.00',
    });
    await request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', sig)
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect((await ledger.getBalance('client:7')).toString()).toBe('150');
  });

  it('rejeita assinatura inválida com 401', async () => {
    const { body } = sign({ event: 'payment.confirmed', paymentId: 'x', userId: '7', amount: '1.00' });
    await request(app.getHttpServer())
      .post('/webhooks/psp')
      .set('x-psp-signature', 'wrong')
      .set('content-type', 'application/json')
      .send(body)
      .expect(401);
  });
});
```

- [ ] **Step 6: Habilitar rawBody no bootstrap**

Modify `src/main.ts`:
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

- [ ] **Step 7: Implementar o controller e registrar o validador**

Create `src/wallet/wallet.controller.ts`:
```typescript
import {
  Body,
  Controller,
  Headers,
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
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-psp-signature') signature: string,
    @Body() event: PspEvent,
  ): Promise<{ received: boolean }> {
    const raw = req.rawBody;
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
```

Modify `src/wallet/wallet.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { PspSignatureValidator } from './psp-signature.validator';

@Module({
  imports: [LedgerModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    {
      provide: PspSignatureValidator,
      useFactory: (): PspSignatureValidator =>
        new PspSignatureValidator(process.env.PSP_WEBHOOK_SECRET ?? ''),
    },
  ],
  exports: [WalletService],
})
export class WalletModule {}
```

- [ ] **Step 8: Instalar supertest e rodar os testes**

Run:
```bash
npm install -D supertest @types/supertest
npm run test:int -- test/wallet.webhook.e2e-spec.ts
```
Expected: PASS — 2 testes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(wallet): PSP webhook with HMAC signature validation"
```

---

### Task 6: Cash-out — requestPayout (KYC + mínimo + débito atômico)

**Files:**
- Create: `src/kyc/kyc.port.ts`
- Create: `src/kyc/table-kyc.adapter.ts`
- Create: `src/kyc/kyc.module.ts`
- Create: `src/payout/payout.service.ts`
- Create: `src/payout/payout.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/payout.request.spec.ts`

**Interfaces:**
- Consumes: `LedgerService.postTransaction`, `LedgerService.getBalance` (Task 3); `PrismaService`.
- Produces:
  - `KycPort` (interface) + token `KYC_PORT`: `isApproved(account: string): Promise<boolean>`.
  - `TableKycAdapter` implementa `KycPort` lendo a tabela `kyc_status`.
  - `PayoutService.requestPayout(account: string, amount: Prisma.Decimal, pixKey: string): Promise<Payout>` — exige KYC aprovado, valor ≥ `MIN_PAYOUT`, saldo suficiente; cria `Payout` PENDING e posta o débito (`SAQUE`) em uma única transação.

- [ ] **Step 1: Escrever os testes que falham**

Create `test/payout.request.spec.ts`:
```typescript
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
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run:
```bash
npm run test:int -- test/payout.request.spec.ts
```
Expected: FAIL — módulos `KycModule`/`PayoutModule` inexistentes.

- [ ] **Step 3: Criar a porta de KYC e o adaptador**

Create `src/kyc/kyc.port.ts`:
```typescript
export const KYC_PORT = 'KYC_PORT';

export interface KycPort {
  isApproved(account: string): Promise<boolean>;
}
```

Create `src/kyc/table-kyc.adapter.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KycPort } from './kyc.port';

@Injectable()
export class TableKycAdapter implements KycPort {
  constructor(private readonly prisma: PrismaService) {}

  async isApproved(account: string): Promise<boolean> {
    const status = await this.prisma.kycStatus.findUnique({ where: { account } });
    return status?.approved ?? false;
  }
}
```

Create `src/kyc/kyc.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { KYC_PORT } from './kyc.port';
import { TableKycAdapter } from './table-kyc.adapter';

@Module({
  providers: [{ provide: KYC_PORT, useClass: TableKycAdapter }],
  exports: [KYC_PORT],
})
export class KycModule {}
```

- [ ] **Step 4: Implementar o PayoutService**

Create `src/payout/payout.service.ts`:
```typescript
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Payout, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { KYC_PORT, KycPort } from '../kyc/kyc.port';

@Injectable()
export class PayoutService {
  private readonly minPayout: Prisma.Decimal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(KYC_PORT) private readonly kyc: KycPort,
  ) {
    this.minPayout = new Prisma.Decimal(process.env.MIN_PAYOUT ?? '200.00');
  }

  async requestPayout(
    account: string,
    amount: Prisma.Decimal,
    pixKey: string,
  ): Promise<Payout> {
    if (!(await this.kyc.isApproved(account))) {
      throw new ForbiddenException('KYC not approved');
    }
    if (amount.lessThan(this.minPayout)) {
      throw new BadRequestException('Amount below minimum payout');
    }

    return this.prisma.$transaction(async (tx) => {
      const balance = await this.ledger.getBalance(account, tx);
      if (balance.lessThan(amount)) {
        throw new BadRequestException('Insufficient balance');
      }
      const payout = await tx.payout.create({
        data: { account, amount, status: 'PENDING', pixKey },
      });
      await this.ledger.postTransaction(
        `payout:${payout.id}`,
        [
          { account, entryType: 'SAQUE', amount: amount.negated() },
          { account: 'source:external', entryType: 'SAQUE_OFFSET', amount },
        ],
        tx,
      );
      return payout;
    });
  }
}
```

Create `src/payout/payout.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { KycModule } from '../kyc/kyc.module';
import { PayoutService } from './payout.service';

@Module({
  imports: [LedgerModule, KycModule],
  providers: [PayoutService],
  exports: [PayoutService],
})
export class PayoutModule {}
```

Modify `src/app.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { LedgerModule } from './ledger/ledger.module';
import { WalletModule } from './wallet/wallet.module';
import { KycModule } from './kyc/kyc.module';
import { PayoutModule } from './payout/payout.module';

@Module({
  imports: [PrismaModule, LedgerModule, WalletModule, KycModule, PayoutModule],
})
export class AppModule {}
```

- [ ] **Step 5: Rodar os testes**

Run:
```bash
npm run test:int -- test/payout.request.spec.ts
```
Expected: PASS — 4 testes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(payout): requestPayout with KYC gate, minimum and atomic debit"
```

---

### Task 7: Processador de saques (porta de PSP de saída + estorno)

**Files:**
- Create: `src/payout/psp-payout.port.ts`
- Create: `src/payout/fake-psp-payout.adapter.ts`
- Create: `src/payout/payout.processor.ts`
- Modify: `src/payout/payout.module.ts`
- Test: `test/payout.processor.spec.ts`

**Interfaces:**
- Consumes: `LedgerService.postTransaction` (Task 3); `PrismaService`; tabela `payouts`.
- Produces:
  - `PspPayoutPort` (interface) + token `PSP_PAYOUT_PORT`: `sendPix(pixKey: string, amount: string): Promise<void>` (rejeita em falha).
  - `FakePspPayoutPort` configurável (`failNext()`), para testes e dev.
  - `PayoutProcessor.processPending(): Promise<void>` — para cada payout PENDING chama `sendPix`; sucesso → `PAID`; falha → estorna o débito no ledger e marca `FAILED`.

- [ ] **Step 1: Escrever os testes que falham**

Create `test/payout.processor.spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerModule } from '../src/ledger/ledger.module';
import { LedgerService } from '../src/ledger/ledger.service';
import { KycModule } from '../src/kyc/kyc.module';
import { PayoutModule } from '../src/payout/payout.module';
import { PayoutService } from '../src/payout/payout.service';
import { PayoutProcessor } from '../src/payout/payout.processor';
import { PSP_PAYOUT_PORT } from '../src/payout/psp-payout.port';
import { FakePspPayoutPort } from '../src/payout/fake-psp-payout.adapter';

describe('PayoutProcessor', () => {
  let processor: PayoutProcessor;
  let payoutSvc: PayoutService;
  let ledger: LedgerService;
  let prisma: PrismaService;
  let fakePsp: FakePspPayoutPort;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, KycModule, PayoutModule],
    }).compile();
    processor = moduleRef.get(PayoutProcessor);
    payoutSvc = moduleRef.get(PayoutService);
    ledger = moduleRef.get(LedgerService);
    prisma = moduleRef.get(PrismaService);
    fakePsp = moduleRef.get(PSP_PAYOUT_PORT);
  });
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.payout.deleteMany();
    await prisma.kycStatus.deleteMany();
    fakePsp.reset();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function seedAndRequest(account: string): Promise<string> {
    await prisma.kycStatus.create({ data: { account, approved: true } });
    await ledger.postTransaction(`seed:${account}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('300.00') },
      { account: 'source:external', entryType: 'SEED_OFFSET', amount: new Prisma.Decimal('-300.00') },
    ]);
    const p = await payoutSvc.requestPayout(account, new Prisma.Decimal('300.00'), 'k');
    return p.id;
  }

  it('marca PAID e chama o PSP em sucesso', async () => {
    const id = await seedAndRequest('model:2');
    await processor.processPending();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('PAID');
    expect(fakePsp.sent).toHaveLength(1);
    expect((await ledger.getBalance('model:2')).toString()).toBe('0');
  });

  it('em falha do PSP: marca FAILED e estorna o saldo', async () => {
    const id = await seedAndRequest('model:3');
    fakePsp.failNext();
    await processor.processPending();
    const p = await prisma.payout.findUnique({ where: { id } });
    expect(p?.status).toBe('FAILED');
    expect((await ledger.getBalance('model:3')).toString()).toBe('300');
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run:
```bash
npm run test:int -- test/payout.processor.spec.ts
```
Expected: FAIL — `PayoutProcessor` / porta inexistentes.

- [ ] **Step 3: Criar a porta e o adaptador fake**

Create `src/payout/psp-payout.port.ts`:
```typescript
export const PSP_PAYOUT_PORT = 'PSP_PAYOUT_PORT';

export interface PspPayoutPort {
  sendPix(pixKey: string, amount: string): Promise<void>;
}
```

Create `src/payout/fake-psp-payout.adapter.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { PspPayoutPort } from './psp-payout.port';

@Injectable()
export class FakePspPayoutPort implements PspPayoutPort {
  public sent: Array<{ pixKey: string; amount: string }> = [];
  private shouldFail = false;

  failNext(): void {
    this.shouldFail = true;
  }

  reset(): void {
    this.sent = [];
    this.shouldFail = false;
  }

  async sendPix(pixKey: string, amount: string): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error('PSP payout failed');
    }
    this.sent.push({ pixKey, amount });
  }
}
```

- [ ] **Step 4: Implementar o PayoutProcessor**

Create `src/payout/payout.processor.ts`:
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PSP_PAYOUT_PORT, PspPayoutPort } from './psp-payout.port';

@Injectable()
export class PayoutProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Inject(PSP_PAYOUT_PORT) private readonly psp: PspPayoutPort,
  ) {}

  async processPending(): Promise<void> {
    const pending = await this.prisma.payout.findMany({
      where: { status: 'PENDING' },
    });

    for (const payout of pending) {
      try {
        await this.psp.sendPix(payout.pixKey, payout.amount.toString());
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
          await tx.payout.update({
            where: { id: payout.id },
            data: { status: 'FAILED', processedAt: new Date() },
          });
        });
      }
    }
  }
}
```

- [ ] **Step 5: Registrar processor + porta no módulo**

Modify `src/payout/payout.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { KycModule } from '../kyc/kyc.module';
import { PayoutService } from './payout.service';
import { PayoutProcessor } from './payout.processor';
import { PSP_PAYOUT_PORT } from './psp-payout.port';
import { FakePspPayoutPort } from './fake-psp-payout.adapter';

@Module({
  imports: [LedgerModule, KycModule],
  providers: [
    PayoutService,
    PayoutProcessor,
    { provide: PSP_PAYOUT_PORT, useClass: FakePspPayoutPort },
  ],
  exports: [PayoutService, PayoutProcessor],
})
export class PayoutModule {}
```

> Nota: `FakePspPayoutPort` é o adaptador atual (dev/teste). Quando o subsistema de pagamentos plugar um PSP real (Suitpay/Pushin etc.), troca-se apenas o `useClass` por um adaptador real que implemente `PspPayoutPort` — nada mais muda. O multi-PSP/failover do blueprint vive nesse ponto de extensão.

- [ ] **Step 6: Rodar os testes**

Run:
```bash
npm run test:int -- test/payout.processor.spec.ts
```
Expected: PASS — 2 testes.

- [ ] **Step 7: Rodar a suíte completa**

Run:
```bash
npm run test:int
```
Expected: PASS — todos os specs (smoke, schema, ledger, recharge, signature, webhook, payout request, payout processor).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(payout): processor with PSP port (Strategy) and ledger reversal on failure"
```

---

## Cobertura do spec (self-review)

| Requisito do blueprint (seção) | Onde é atendido |
|---|---|
| Ledger dupla entrada, append-only (4.2) | Task 2 (schema), Task 3 (`postTransaction` sem update/delete) |
| Toda transação soma zero (Global) | Task 3 (validação + teste de rejeição) |
| Idempotência por `ref_idempotencia` (4.2) | Task 2 (unique), Task 3 (P2002 → no-op), Task 4 (webhook duplicado) |
| Saldo = `SUM(amount)` (4.2) | Task 3 (`getBalance`) |
| Cash-in via webhook validado do PSP (4.2) | Task 4 (crédito) + Task 5 (assinatura HMAC + controller) |
| Take rate por modelo como configuração (4.3) | Fora de escopo (Billing Engine); `postTransaction` é o primitivo que ele usará |
| Cash-out com mínimo + fila + KYC (4.2, 4.6) | Task 6 (mínimo, KYC port, débito atômico) + Task 7 (fila/processor) |
| PSP de saída plugável / failover (3.1) | Task 7 (`PspPayoutPort` Strategy + fake; ponto de troca documentado) |
| Dinheiro decimal, nunca float (Global) | Todas as tasks usam `Prisma.Decimal` |
| Cache Redis (4.2) | Adiado conscientemente (ver Global Constraints) |
| Conta = cliente OU modelo, nunca ambos (4.1) | Fora de escopo (Identidade & Acesso); ledger usa contas namespaced (`client:`/`model:`) que tornam a separação verificável |

Sem placeholders. Tipos consistentes entre tasks (`postTransaction`/`getBalance`/`requestPayout`/`processPending` e tokens `KYC_PORT`/`PSP_PAYOUT_PORT` usados igual onde são produzidos e consumidos).
