# Motor de Chamadas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a orquestração das chamadas de voz da Samy — ciclo de vida ring/accept (REQUESTED→ACTIVE→ENDED), gate de início com blindagem de concorrência (advisory lock), token de sala de mídia via porta, hangup/pânico/endCall, e a integração OCUPADA na descoberta.

**Architecture:** NestJS + Prisma + Postgres + Redis (já no stack). A integridade financeira (no máximo uma chamada aberta por cliente/modelo) é imposta por `pg_advisory_xact_lock` dentro de `$transaction` (mesmo padrão do saque do ledger) + re-check no accept. Transições de chamada única usam updateMany condicional (compare-and-swap). A mídia entra por uma porta (`MediaServerProvider`: fake + LiveKit stub). Calls usa `RedisService` (@Global) e lê `ModelProfile` via Prisma — NÃO importa MarketplaceModule; o Marketplace importa CallsModule (mão única, sem ciclo).

**Tech Stack:** NestJS, Prisma v5.22.0, PostgreSQL, Redis, Jest (integração contra Postgres + Redis reais; MediaServer fake), supertest.

## Global Constraints

- **No máximo UMA chamada não-ENDED por cliente E por modelo** — imposto por advisory lock por entidade dentro da transação; locks adquiridos em ordem determinística (chaves ordenadas) p/ evitar deadlock.
- **Re-check atômico no accept** (sob advisory lock do cliente, re-lendo a call): ainda REQUESTED e não expirada; cliente sem OUTRA ACTIVE; `saldo >= pricePerMinuteSnapshot`. Falha → call vira ENDED (motivo) + erro.
- **Gate de início:** modelo role=MODEL + status=ACTIVE + tem ModelProfile + presença ONLINE + sem chamada aberta; cliente `saldo >= pricePerMinute` (≥1 min) + sem chamada aberta.
- **`pricePerMinuteSnapshot`** Decimal(14,2) capturado no REQUESTED (Billing usa esse, não o corrente).
- **Transições single-call (reject/hangup/panic/endCall)** via `updateMany` condicional no status (CAS atômico, idempotente).
- **Timeout lazy:** REQUESTED com idade > `RING_TIMEOUT_SECONDS = 30` → ENDED(TIMEOUT) na leitura/accept.
- **Token de mídia sob demanda** (no accept p/ modelo; no GET p/ cada participante), identidade `client:<id>` / `model:<id>`.
- **`endCall(callId, reason)`** método de serviço exportado (sem HTTP) — Billing chama com `NO_CREDITS`. Idempotente.
- **402** via `new HttpException('insufficient balance', HttpStatus.PAYMENT_REQUIRED)` (Nest não tem exceção pronta).
- **OCUPADA derivada** de call ACTIVE; o card da descoberta vira `status: 'ONLINE'|'OCUPADA'|'OFFLINE'` (substitui `isOnline`); ordenação ONLINE→OCUPADA→OFFLINE→favoritas→recência.
- **Sem ciclo:** CallsModule importa Prisma/Ledger/Auth/Users (Redis @Global); MarketplaceModule importa CallsModule.
- **`npx tsc --noEmit` limpo;** `import type` em interfaces injetadas.
- **Migração não-interativa** (migrate diff + deploy, UTF-8 sem BOM); teste via `db:test:push`.
- **Não alterar** ledger/identidade/kyc; Marketplace muda só no card (status) + import do CallsModule.

---

### Task 1: Schema Call

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260622010000_calls/migration.sql`
- Test: `test/calls-schema.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient`.
- Produces: tabela `calls`; tipo Prisma `Call`.

- [ ] **Step 1: Escrever o teste que falha**

Create `test/calls-schema.spec.ts`:
```typescript
import { PrismaClient, Prisma } from '@prisma/client';

describe('calls schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => { await prisma.call.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); });

  it('cria call REQUESTED com snapshot de preço', async () => {
    const c = await prisma.call.create({
      data: { clientUserId: 'c1', modelUserId: 'm1', status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00') },
    });
    expect(c.status).toBe('REQUESTED');
    expect(c.pricePerMinuteSnapshot.toString()).toBe('5');
    expect(c.startedAt).toBeNull();
    expect(c.endReason).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/calls-schema.spec.ts`
Expected: FAIL — `prisma.call` não existe.

- [ ] **Step 3: Adicionar o modelo ao schema**

Add to `prisma/schema.prisma` (após os modelos existentes):
```prisma
model Call {
  id                     String    @id @default(uuid())
  clientUserId           String
  modelUserId            String
  status                 String
  endReason              String?
  pricePerMinuteSnapshot Decimal   @db.Decimal(14, 2)
  roomName               String?
  requestedAt            DateTime  @default(now())
  startedAt              DateTime?
  endedAt                DateTime?

  @@index([modelUserId, status])
  @@index([clientUserId, status])
  @@map("calls")
}
```

- [ ] **Step 4: Gerar migration não-interativa e aplicar**

Run (Bash/Git Bash p/ UTF-8 sem BOM):
```bash
mkdir -p prisma/migrations/20260622010000_calls
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260622010000_calls/migration.sql
npx prisma generate
npx prisma migrate deploy
```
Confirme `CREATE TABLE "calls"` com os dois índices e sem dropar outras tabelas. P3018 (BOM) → reescreva UTF-8 sem BOM.

- [ ] **Step 5: Rodar o teste**

Run: `npm run test:int -- test/calls-schema.spec.ts`
Expected: PASS (1 teste).

- [ ] **Step 6: Commit**

```bash
git add prisma test/calls-schema.spec.ts
git commit -m "feat(calls): Call schema (lifecycle + price snapshot)"
```

---

### Task 2: MediaServerProvider (porta + fake + LiveKit stub)

**Files:**
- Create: `src/calls/media-server.port.ts`
- Create: `src/calls/fake-media-server.adapter.ts`
- Create: `src/calls/livekit-media-server.adapter.ts`
- Test: `test/media-server.fake.spec.ts`

**Interfaces:**
- Consumes: nada do projeto.
- Produces:
  - `MEDIA_SERVER` (token) + `MediaToken = { token: string; url: string }` + interface `MediaServerProvider` com `issueToken(roomName: string, identity: string): Promise<MediaToken>`.
  - `FakeMediaServer` (token/url determinístico, sem rede). `LivekitMediaServer` stub: `issueToken` lança `Error('media server not configured')`; construtor não exige env (app boota).

- [ ] **Step 1: Escrever o teste do fake**

Create `test/media-server.fake.spec.ts`:
```typescript
import { FakeMediaServer } from '../src/calls/fake-media-server.adapter';

describe('FakeMediaServer', () => {
  it('emite token e url determinísticos para a identidade', async () => {
    const fake = new FakeMediaServer();
    const a = await fake.issueToken('call:1', 'model:9');
    expect(a.token).toContain('call:1');
    expect(a.token).toContain('model:9');
    expect(a.url).toMatch(/^wss:\/\//);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/media-server.fake.spec.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Criar a porta**

Create `src/calls/media-server.port.ts`:
```typescript
export const MEDIA_SERVER = 'MEDIA_SERVER';

export interface MediaToken {
  token: string;
  url: string;
}

export interface MediaServerProvider {
  issueToken(roomName: string, identity: string): Promise<MediaToken>;
}
```

- [ ] **Step 4: Criar fake + stub real**

Create `src/calls/fake-media-server.adapter.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import type { MediaServerProvider, MediaToken } from './media-server.port';

@Injectable()
export class FakeMediaServer implements MediaServerProvider {
  async issueToken(roomName: string, identity: string): Promise<MediaToken> {
    return { token: `tok:${roomName}:${identity}`, url: 'wss://fake.media/room' };
  }
}
```

Create `src/calls/livekit-media-server.adapter.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import type { MediaServerProvider, MediaToken } from './media-server.port';

@Injectable()
export class LivekitMediaServer implements MediaServerProvider {
  async issueToken(_roomName: string, _identity: string): Promise<MediaToken> {
    throw new Error('media server not configured');
  }
}
```

- [ ] **Step 5: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/media-server.fake.spec.ts
npx tsc --noEmit
```
Expected: PASS (1 teste) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/calls/media-server.port.ts src/calls/fake-media-server.adapter.ts src/calls/livekit-media-server.adapter.ts test/media-server.fake.spec.ts
git commit -m "feat(calls): MediaServerProvider port with fake and livekit-stub adapters"
```

---

### Task 3: CallService.initiate (advisory lock + gate) + POST /calls + módulo

**Files:**
- Create: `src/calls/call.service.ts`
- Create: `src/calls/call.controller.ts`
- Create: `src/calls/calls.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/call.initiate.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `LedgerService.getBalance(account, tx?)`, `RedisService.getStatus(modelId)`, `MEDIA_SERVER`; guards.
- Produces:
  - `CallService.initiate(clientId: string, modelId: string): Promise<Call>` — advisory-lock client+model; gate; cria REQUESTED.
  - private `lock(tx, keys: string[])` (ordena e aplica `pg_advisory_xact_lock(hashtext(key))`); private `isExpired(requestedAt): boolean` (> 30s); const `RING_TIMEOUT_SECONDS = 30`.
  - `POST /calls { modelId }` (`@Roles('CLIENT')`).
  - `CallsModule` (imports Prisma, Ledger, Auth, Users; provê CallService + `{provide: MEDIA_SERVER, useClass: LivekitMediaServer}`; controller; exporta CallService). Registrado em AppModule.

- [ ] **Step 1: Escrever o teste e2e (feliz + gate + concorrência)**

Create `test/call.initiate.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { MEDIA_SERVER } from '../src/calls/media-server.port';
import { FakeMediaServer } from '../src/calls/fake-media-server.adapter';

describe('Call initiate', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let fakeId: FakeIdentityProvider;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .overrideProvider(MEDIA_SERVER).useClass(FakeMediaServer)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
    await prisma.call.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await raw.quit(); await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function makeOnlineModel(sub: string, price = '5.00'): Promise<string> {
    const m = await login(sub, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: `S-${sub}`, pricePerMinute: new Prisma.Decimal(price), tags: [] } });
    await raw.set(`presence:model:${m.id}`, 'ONLINE', 'EX', 30);
    return m.id;
  }
  async function credit(clientId: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${clientId}:${amount}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }

  it('cliente com saldo liga p/ modelo online → REQUESTED', async () => {
    const modelId = await makeOnlineModel('mod1');
    const client = await login('cli1', 'CLIENT');
    await credit(client.id, '20.00');
    const res = await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId }).expect(201);
    expect(res.body.status).toBe('REQUESTED');
    expect(res.body.pricePerMinuteSnapshot).toBe('5');
  });

  it('saldo < preço → 402', async () => {
    const modelId = await makeOnlineModel('mod2', '5.00');
    const client = await login('cli2', 'CLIENT');
    await credit(client.id, '3.00');
    await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId }).expect(402);
  });

  it('modelo OFFLINE → 409', async () => {
    const m = await login('mod3', 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: 'S', pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    const client = await login('cli3', 'CLIENT');
    await credit(client.id, '20.00');
    await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: m.id }).expect(409);
  });

  it('modelo inexistente/não-MODEL → 404', async () => {
    const client = await login('cli4', 'CLIENT');
    await credit(client.id, '20.00');
    await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: '00000000-0000-0000-0000-000000000000' }).expect(404);
  });

  it('MODEL no POST /calls → 403', async () => {
    const m = await login('mod5', 'MODEL');
    await http().post('/calls').set('Authorization', `Bearer ${m.token}`).send({ modelId: 'x' }).expect(403);
  });

  it('concorrência: cliente abre 2 chamadas ao mesmo tempo → só 1 REQUESTED', async () => {
    const a = await makeOnlineModel('modA');
    const b = await makeOnlineModel('modB');
    const client = await login('cli6', 'CLIENT');
    await credit(client.id, '20.00');
    const [r1, r2] = await Promise.allSettled([
      http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: a }),
      http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: b }),
    ]);
    const statuses = [r1, r2].map((r) => (r.status === 'fulfilled' ? r.value.status : 0));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
    expect(await prisma.call.count({ where: { clientUserId: client.id, status: { not: 'ENDED' } } })).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/call.initiate.e2e-spec.ts`
Expected: FAIL — rota `/calls` inexistente.

- [ ] **Step 3: Implementar o CallService (initiate + helpers)**

Create `src/calls/call.service.ts`:
```typescript
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Call, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import { MEDIA_SERVER } from './media-server.port';
import type { MediaServerProvider, MediaToken } from './media-server.port';

const RING_TIMEOUT_SECONDS = 30;

@Injectable()
export class CallService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly redis: RedisService,
    @Inject(MEDIA_SERVER) private readonly media: MediaServerProvider,
  ) {}

  async initiate(clientId: string, modelId: string): Promise<Call> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, [`call-client:${clientId}`, `call-model:${modelId}`]);

      const clientOpen = await tx.call.findFirst({
        where: { clientUserId: clientId, status: { not: 'ENDED' } },
      });
      if (clientOpen) {
        throw new ConflictException('client already in a call');
      }

      const model = await tx.user.findUnique({ where: { id: modelId } });
      const profile = await tx.modelProfile.findUnique({ where: { userId: modelId } });
      if (!model || model.role !== 'MODEL' || model.status !== 'ACTIVE' || !profile) {
        throw new NotFoundException('model not available');
      }

      const modelOpen = await tx.call.findFirst({
        where: { modelUserId: modelId, status: { not: 'ENDED' } },
      });
      if (modelOpen) {
        throw new ConflictException('model busy');
      }
      if ((await this.redis.getStatus(modelId)) !== 'ONLINE') {
        throw new ConflictException('model offline');
      }

      const balance = await this.ledger.getBalance(`client:${clientId}`, tx);
      if (balance.lessThan(profile.pricePerMinute)) {
        throw new HttpException('insufficient balance', HttpStatus.PAYMENT_REQUIRED);
      }

      return tx.call.create({
        data: {
          clientUserId: clientId,
          modelUserId: modelId,
          status: 'REQUESTED',
          pricePerMinuteSnapshot: profile.pricePerMinute,
        },
      });
    });
  }

  private async lock(tx: Prisma.TransactionClient, keys: string[]): Promise<void> {
    for (const k of [...keys].sort()) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))`;
    }
  }

  private isExpired(requestedAt: Date): boolean {
    return Date.now() - requestedAt.getTime() > RING_TIMEOUT_SECONDS * 1000;
  }
}
```

> Nota: as tasks 4-5 adicionam `accept`/`reject`/`hangup`/`panic`/`endCall`/`getForParticipant`; a task 6 adiciona `activeModelIds`. `isExpired`/`media`/`MediaToken` já ficam disponíveis aqui.

- [ ] **Step 4: Implementar o controller + módulo + wiring**

Create `src/calls/call.controller.ts`:
```typescript
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CallService } from './call.service';

interface InitiateDto {
  modelId: string;
}

@Controller('calls')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CallController {
  constructor(private readonly calls: CallService) {}

  @Post()
  @Roles('CLIENT')
  async initiate(@Req() req: Request & { user: AuthUser }, @Body() dto: InitiateDto): Promise<unknown> {
    return this.calls.initiate(req.user.id, dto.modelId);
  }
}
```

Create `src/calls/calls.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { CallService } from './call.service';
import { CallController } from './call.controller';
import { MEDIA_SERVER } from './media-server.port';
import { LivekitMediaServer } from './livekit-media-server.adapter';

@Module({
  imports: [PrismaModule, LedgerModule, AuthModule, UsersModule],
  controllers: [CallController],
  providers: [CallService, { provide: MEDIA_SERVER, useClass: LivekitMediaServer }],
  exports: [CallService],
})
export class CallsModule {}
```

Modify `src/app.module.ts` — importar `CallsModule` (mantendo todos os imports existentes).

- [ ] **Step 5: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/call.initiate.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (6 testes, incluindo o de concorrência) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/calls/call.service.ts src/calls/call.controller.ts src/calls/calls.module.ts src/app.module.ts test/call.initiate.e2e-spec.ts
git commit -m "feat(calls): initiate with advisory-lock gate (one open call per client/model) + POST /calls"
```

---

### Task 4: accept (re-check) + reject

**Files:**
- Modify: `src/calls/call.service.ts`
- Modify: `src/calls/call.controller.ts`
- Test: `test/call.accept.e2e-spec.ts`

**Interfaces:**
- Consumes: o que a Task 3 produziu.
- Produces:
  - `CallService.accept(callId: string, modelId: string): Promise<{ call: Call; media: MediaToken }>` — re-check sob lock; REQUESTED→ACTIVE; emite token da modelo. Lança 404/403/409/402 conforme §6.2.
  - `CallService.reject(callId: string, modelId: string): Promise<Call>` — REQUESTED→ENDED(REJECTED).
  - `POST /calls/:id/accept`, `POST /calls/:id/reject` (`@Roles('MODEL')`).

- [ ] **Step 1: Escrever o teste e2e**

Create `test/call.accept.e2e-spec.ts` (reusa os helpers; cobre accept feliz, reject, papel, e re-check sem saldo):
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { MEDIA_SERVER } from '../src/calls/media-server.port';
import { FakeMediaServer } from '../src/calls/fake-media-server.adapter';

describe('Call accept/reject', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let fakeId: FakeIdentityProvider;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .overrideProvider(MEDIA_SERVER).useClass(FakeMediaServer)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
    await prisma.call.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await raw.quit(); await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function onlineModel(sub: string): Promise<{ token: string; id: string }> {
    const m = await login(sub, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: `S-${sub}`, pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    await raw.set(`presence:model:${m.id}`, 'ONLINE', 'EX', 30);
    return m;
  }
  async function credit(clientId: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${clientId}:${amount}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  async function ring(modelSub: string): Promise<{ callId: string; model: { token: string; id: string }; client: { token: string; id: string } }> {
    const model = await onlineModel(modelSub);
    const client = await login(`cli-${modelSub}`, 'CLIENT');
    await credit(client.id, '20.00');
    const res = await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: model.id }).expect(201);
    return { callId: res.body.id, model, client };
  }

  it('modelo aceita → ACTIVE + token de mídia', async () => {
    const { callId, model } = await ring('m1');
    const res = await http().post(`/calls/${callId}/accept`).set('Authorization', `Bearer ${model.token}`).expect(201);
    expect(res.body.call.status).toBe('ACTIVE');
    expect(res.body.call.roomName).toBe(`call:${callId}`);
    expect(res.body.media.token).toContain(`call:${callId}`);
  });

  it('modelo rejeita → ENDED(REJECTED)', async () => {
    const { callId, model } = await ring('m2');
    const res = await http().post(`/calls/${callId}/reject`).set('Authorization', `Bearer ${model.token}`).expect(201);
    expect(res.body.status).toBe('ENDED');
    expect(res.body.endReason).toBe('REJECTED');
  });

  it('CLIENT no accept → 403', async () => {
    const { callId, client } = await ring('m3');
    await http().post(`/calls/${callId}/accept`).set('Authorization', `Bearer ${client.token}`).expect(403);
  });

  it('re-check: saldo sumiu antes do accept → 402 e call ENDED(NO_CREDITS)', async () => {
    const { callId, model, client } = await ring('m4');
    // zera o saldo do cliente (debita tudo) antes do accept
    await ledger.postTransaction(`drain:${client.id}`, [
      { account: `client:${client.id}`, entryType: 'CONSUMO', amount: new Prisma.Decimal('-20.00') },
      { account: 'source:external', entryType: 'DRAIN', amount: new Prisma.Decimal('20.00') },
    ]);
    await http().post(`/calls/${callId}/accept`).set('Authorization', `Bearer ${model.token}`).expect(402);
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.status).toBe('ENDED');
    expect(call?.endReason).toBe('NO_CREDITS');
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/call.accept.e2e-spec.ts`
Expected: FAIL — rota accept inexistente.

- [ ] **Step 3: Adicionar accept + reject ao CallService**

Add to `src/calls/call.service.ts` (dentro da classe, após `initiate`):
```typescript
  async accept(callId: string, modelId: string): Promise<{ call: Call; media: MediaToken }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const found = await tx.call.findUnique({ where: { id: callId } });
      if (!found) {
        throw new NotFoundException('call not found');
      }
      if (found.modelUserId !== modelId) {
        throw new ConflictException('not your call');
      }
      await this.lock(tx, [`call-client:${found.clientUserId}`]);
      const call = await tx.call.findUnique({ where: { id: callId } });
      if (!call) {
        throw new NotFoundException('call not found');
      }
      if (call.status === 'REQUESTED' && this.isExpired(call.requestedAt)) {
        await tx.call.update({ where: { id: callId }, data: { status: 'ENDED', endReason: 'TIMEOUT', endedAt: new Date() } });
        throw new ConflictException('call expired');
      }
      if (call.status !== 'REQUESTED') {
        throw new ConflictException('call not pending');
      }
      const otherActive = await tx.call.findFirst({
        where: { clientUserId: call.clientUserId, status: 'ACTIVE', id: { not: callId } },
      });
      if (otherActive) {
        throw new ConflictException('client already in a call');
      }
      const balance = await this.ledger.getBalance(`client:${call.clientUserId}`, tx);
      if (balance.lessThan(call.pricePerMinuteSnapshot)) {
        await tx.call.update({ where: { id: callId }, data: { status: 'ENDED', endReason: 'NO_CREDITS', endedAt: new Date() } });
        throw new HttpException('insufficient balance', HttpStatus.PAYMENT_REQUIRED);
      }
      const roomName = `call:${callId}`;
      const active = await tx.call.update({
        where: { id: callId },
        data: { status: 'ACTIVE', startedAt: new Date(), roomName },
      });
      return active;
    });
    const media = await this.media.issueToken(result.roomName as string, `model:${modelId}`);
    return { call: result, media };
  }

  async reject(callId: string, modelId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.modelUserId !== modelId) {
      throw new ConflictException('not your call');
    }
    const res = await this.prisma.call.updateMany({
      where: { id: callId, status: 'REQUESTED' },
      data: { status: 'ENDED', endReason: 'REJECTED', endedAt: new Date() },
    });
    if (res.count === 0) {
      throw new ConflictException('call not pending');
    }
    return this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }
```
(O token de mídia é emitido FORA da transação, depois do commit — evita prender a tx durante a emissão.)

- [ ] **Step 4: Adicionar os endpoints no controller**

Modify `src/calls/call.controller.ts` — adicionar imports `Param` e os métodos:
```typescript
import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
```
e dentro da classe:
```typescript
  @Post(':id/accept')
  @Roles('MODEL')
  async accept(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    return this.calls.accept(id, req.user.id);
  }

  @Post(':id/reject')
  @Roles('MODEL')
  async reject(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    return this.calls.reject(id, req.user.id);
  }
```

- [ ] **Step 5: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/call.accept.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (4 testes) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/calls/call.service.ts src/calls/call.controller.ts test/call.accept.e2e-spec.ts
git commit -m "feat(calls): accept (atomic balance/state re-check) + reject"
```

---

### Task 5: hangup + panic + endCall + GET /calls/:id (lazy timeout)

**Files:**
- Modify: `src/calls/call.service.ts`
- Modify: `src/calls/call.controller.ts`
- Test: `test/call.end.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3-4.
- Produces:
  - `CallService.hangup(callId, userId): Promise<Call>` — participante encerra (ACTIVE→ENDED(HANGUP_CLIENT|HANGUP_MODEL); REQUESTED+cliente→cancela; já ENDED→no-op).
  - `CallService.panic(callId, modelId): Promise<Call>` — ACTIVE→ENDED(PANIC).
  - `CallService.endCall(callId, reason): Promise<void>` — ACTIVE→ENDED(reason), idempotente (uso do Billing).
  - `CallService.getForParticipant(callId, userId, role): Promise<{ call: Call; media?: MediaToken }>` — lazy timeout; token sob demanda se ACTIVE e participante.
  - `POST /calls/:id/hangup`, `POST /calls/:id/panic`, `GET /calls/:id`.

- [ ] **Step 1: Escrever o teste e2e**

Create `test/call.end.e2e-spec.ts` (reusa helpers; cobre hangup, panic, timeout lazy no GET, endCall, e GET com token):
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { CallService } from '../src/calls/call.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { MEDIA_SERVER } from '../src/calls/media-server.port';
import { FakeMediaServer } from '../src/calls/fake-media-server.adapter';

describe('Call hangup/panic/end/get', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let calls: CallService;
  let fakeId: FakeIdentityProvider;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .overrideProvider(MEDIA_SERVER).useClass(FakeMediaServer)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    calls = mod.get(CallService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
    await prisma.call.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await raw.quit(); await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function activeCall(sub: string): Promise<{ callId: string; model: { token: string; id: string }; client: { token: string; id: string } }> {
    const m = await login(`mod-${sub}`, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m.id, stageName: `S-${sub}`, pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    await raw.set(`presence:model:${m.id}`, 'ONLINE', 'EX', 30);
    const client = await login(`cli-${sub}`, 'CLIENT');
    await ledger.postTransaction(`seed:${client.id}`, [
      { account: `client:${client.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal('20.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-20.00') },
    ]);
    const req = await http().post('/calls').set('Authorization', `Bearer ${client.token}`).send({ modelId: m.id }).expect(201);
    await http().post(`/calls/${req.body.id}/accept`).set('Authorization', `Bearer ${m.token}`).expect(201);
    return { callId: req.body.id, model: m, client };
  }

  it('cliente faz hangup de uma chamada ATIVA → ENDED(HANGUP_CLIENT)', async () => {
    const { callId, client } = await activeCall('a');
    const res = await http().post(`/calls/${callId}/hangup`).set('Authorization', `Bearer ${client.token}`).expect(201);
    expect(res.body.status).toBe('ENDED');
    expect(res.body.endReason).toBe('HANGUP_CLIENT');
  });

  it('pânico da modelo → ENDED(PANIC)', async () => {
    const { callId, model } = await activeCall('b');
    const res = await http().post(`/calls/${callId}/panic`).set('Authorization', `Bearer ${model.token}`).expect(201);
    expect(res.body.endReason).toBe('PANIC');
  });

  it('GET /calls/:id participante ATIVO recebe token; lazy timeout numa REQUESTED velha', async () => {
    const { callId, client } = await activeCall('c');
    const got = await http().get(`/calls/${callId}`).set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(got.body.media.token).toContain(`call:${callId}`);
    // cria uma REQUESTED velha e confirma timeout lazy no GET
    const m2 = await login('mod-old', 'MODEL');
    await prisma.user.update({ where: { id: m2.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({ data: { userId: m2.id, stageName: 'old', pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
    const cli2 = await login('cli-old', 'CLIENT');
    const old = await prisma.call.create({
      data: { clientUserId: cli2.id, modelUserId: m2.id, status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00'), requestedAt: new Date(Date.now() - 60000) },
    });
    const res = await http().get(`/calls/${old.id}`).set('Authorization', `Bearer ${cli2.token}`).expect(200);
    expect(res.body.status).toBe('ENDED');
    expect(res.body.endReason).toBe('TIMEOUT');
  });

  it('endCall(NO_CREDITS) encerra a ATIVA e é idempotente', async () => {
    const { callId } = await activeCall('d');
    await calls.endCall(callId, 'NO_CREDITS');
    expect((await prisma.call.findUnique({ where: { id: callId } }))?.endReason).toBe('NO_CREDITS');
    await calls.endCall(callId, 'NO_CREDITS'); // idempotente, sem erro
  });

  it('não-participante no GET → 403', async () => {
    const { callId } = await activeCall('e');
    const intruso = await login('intruso', 'CLIENT');
    await http().get(`/calls/${callId}`).set('Authorization', `Bearer ${intruso.token}`).expect(403);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/call.end.e2e-spec.ts`
Expected: FAIL — rotas inexistentes.

- [ ] **Step 3: Adicionar os métodos ao CallService**

Add to `src/calls/call.service.ts` (dentro da classe):
```typescript
  async hangup(callId: string, userId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.clientUserId !== userId && call.modelUserId !== userId) {
      throw new ForbiddenException('not a participant');
    }
    if (call.status === 'ENDED') {
      return call; // idempotente
    }
    const reason = call.clientUserId === userId ? 'HANGUP_CLIENT' : 'HANGUP_MODEL';
    await this.prisma.call.updateMany({
      where: { id: callId, status: { not: 'ENDED' } },
      data: { status: 'ENDED', endReason: reason, endedAt: new Date() },
    });
    return this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }

  async panic(callId: string, modelId: string): Promise<Call> {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.modelUserId !== modelId) {
      throw new ForbiddenException('not a participant');
    }
    await this.prisma.call.updateMany({
      where: { id: callId, status: { not: 'ENDED' } },
      data: { status: 'ENDED', endReason: 'PANIC', endedAt: new Date() },
    });
    return this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
  }

  async endCall(callId: string, reason: string): Promise<void> {
    await this.prisma.call.updateMany({
      where: { id: callId, status: { not: 'ENDED' } },
      data: { status: 'ENDED', endReason: reason, endedAt: new Date() },
    });
  }

  async getForParticipant(
    callId: string,
    userId: string,
    role: string,
  ): Promise<{ call: Call; media?: MediaToken }> {
    let call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new NotFoundException('call not found');
    }
    if (call.clientUserId !== userId && call.modelUserId !== userId) {
      throw new ForbiddenException('not a participant');
    }
    if (call.status === 'REQUESTED' && this.isExpired(call.requestedAt)) {
      await this.prisma.call.updateMany({
        where: { id: callId, status: 'REQUESTED' },
        data: { status: 'ENDED', endReason: 'TIMEOUT', endedAt: new Date() },
      });
      call = await this.prisma.call.findUniqueOrThrow({ where: { id: callId } });
    }
    if (call.status === 'ACTIVE' && call.roomName) {
      const identity = role === 'MODEL' ? `model:${userId}` : `client:${userId}`;
      const media = await this.media.issueToken(call.roomName, identity);
      return { call, media };
    }
    return { call };
  }
```
Add `ForbiddenException` ao import de `@nestjs/common` no topo do arquivo.

- [ ] **Step 4: Adicionar os endpoints no controller**

Modify `src/calls/call.controller.ts` — adicionar `Get` ao import e os métodos:
```typescript
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
```
e na classe:
```typescript
  @Post(':id/hangup')
  async hangup(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    return this.calls.hangup(id, req.user.id);
  }

  @Post(':id/panic')
  @Roles('MODEL')
  async panic(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    return this.calls.panic(id, req.user.id);
  }

  @Get(':id')
  async get(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    return this.calls.getForParticipant(id, req.user.id, req.user.role);
  }
```
> `hangup` e `get` não levam `@Roles` (ambos os papéis participam); a checagem de participante é no service.

- [ ] **Step 5: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/call.end.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (5 testes) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/calls/call.service.ts src/calls/call.controller.ts test/call.end.e2e-spec.ts
git commit -m "feat(calls): hangup, panic, endCall (Billing seam), GET /calls/:id with lazy timeout + media token"
```

---

### Task 6: OCUPADA na descoberta + activeModelIds + suíte completa

**Files:**
- Modify: `src/calls/call.service.ts`
- Modify: `src/marketplace/discovery.service.ts`
- Modify: `src/marketplace/marketplace.module.ts`
- Modify: `test/discovery.e2e-spec.ts`
- Test: (atualiza o discovery e2e)

**Interfaces:**
- Consumes: `CallService` (importado pelo MarketplaceModule).
- Produces:
  - `CallService.activeModelIds(modelIds: string[]): Promise<Set<string>>` — modelos com call ACTIVE.
  - `ModelCard.status: 'ONLINE' | 'OCUPADA' | 'OFFLINE'` (substitui `isOnline`).
  - Ordenação ONLINE→OCUPADA→OFFLINE→favoritas→createdAt desc.

- [ ] **Step 1: Atualizar os testes da descoberta (isOnline → status + OCUPADA)**

Modify `test/discovery.e2e-spec.ts`:
- No teste do paradoxo, troque `expect(res.body[0].isOnline).toBe(true)` por `expect(res.body[0].status).toBe('ONLINE')`.
- Adicione (após os imports já existentes, sem novos) um teste de OCUPADA. Como o discovery e2e não tem cliente/ledger setup, crie a call ACTIVE direto no banco:
```typescript
  it('modelo em chamada ACTIVE aparece como OCUPADA e ordena depois de ONLINE', async () => {
    const online = await makeModel('on1');
    const busy = await makeModel('busy1');
    await raw.set(`presence:model:${online}`, 'ONLINE', 'EX', 30);
    await raw.set(`presence:model:${busy}`, 'ONLINE', 'EX', 30);
    await prisma.call.create({
      data: { clientUserId: 'someclient', modelUserId: busy, status: 'ACTIVE', pricePerMinuteSnapshot: new Prisma.Decimal('5.00'), startedAt: new Date() },
    });
    const client = await login('cdisc', 'CLIENT');
    const res = await http().get('/models').set('Authorization', `Bearer ${client.token}`).expect(200);
    const byId = new Map(res.body.map((c: { userId: string; status: string }) => [c.userId, c.status]));
    expect(byId.get(busy)).toBe('OCUPADA');
    expect(byId.get(online)).toBe('ONLINE');
    expect(res.body[0].userId).toBe(online); // ONLINE antes de OCUPADA
  });
```
(O `makeModel` já cria presença? Não — ele não seta presença; este teste seta via `raw.set`. Garanta que o arquivo tem `raw` e `Prisma` importados — já tem.)

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/discovery.e2e-spec.ts`
Expected: FAIL — `status` indefinido (card ainda usa `isOnline`).

- [ ] **Step 3: Adicionar `activeModelIds` ao CallService**

Add to `src/calls/call.service.ts`:
```typescript
  async activeModelIds(modelIds: string[]): Promise<Set<string>> {
    if (modelIds.length === 0) {
      return new Set();
    }
    const rows = await this.prisma.call.findMany({
      where: { modelUserId: { in: modelIds }, status: 'ACTIVE' },
      select: { modelUserId: true },
    });
    return new Set(rows.map((r) => r.modelUserId));
  }
```

- [ ] **Step 4: Integrar na DiscoveryService**

Modify `src/marketplace/discovery.service.ts`:
- No `ModelCard`, troque `isOnline: boolean;` por `status: 'ONLINE' | 'OCUPADA' | 'OFFLINE';`.
- Injete `CallService` no construtor: `import { CallService } from '../calls/call.service';` e adicione `private readonly callService: CallService,` aos parâmetros.
- Em `list()`, após obter `presence` e antes de montar os cards, calcule os ocupados e o status, e ajuste o sort:
```typescript
    const presence = await this.presence.getStatuses(candidates.map((p) => p.userId));
    const busy = await this.callService.activeModelIds(candidates.map((p) => p.userId));
    const favoriteIds =
      requester.role === 'CLIENT'
        ? new Set(await this.favorites.listFavoriteModelIds(requester.id))
        : new Set<string>();

    const statusOf = (id: string): 'ONLINE' | 'OCUPADA' | 'OFFLINE' =>
      busy.has(id) ? 'OCUPADA' : presence[id] === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
    const rank = { ONLINE: 0, OCUPADA: 1, OFFLINE: 2 } as const;

    const cards = candidates.map((p) =>
      this.toCard(p, statusOf(p.userId), favoriteIds.has(p.userId)),
    );

    cards.sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      return 0;
    });

    return cards.slice(offset, offset + limit);
```
- Atualize `toCard` para receber `status` em vez de `isOnline`:
```typescript
  private toCard(
    p: { userId: string; stageName: string; bio: string | null; pricePerMinute: { toString(): string }; tags: string[]; voicePreviewUrl: string | null },
    status: 'ONLINE' | 'OCUPADA' | 'OFFLINE',
    isFavorite: boolean,
  ): ModelCard {
    return {
      userId: p.userId,
      stageName: p.stageName,
      bio: p.bio,
      pricePerMinute: p.pricePerMinute.toString(),
      tags: p.tags,
      voicePreviewUrl: p.voicePreviewUrl,
      status,
      isFavorite,
    };
  }
```
- Em `getOne()`, troque a montagem do `isOnline` por `status`:
```typescript
    const busy = await this.callService.activeModelIds([modelId]);
    const status: 'ONLINE' | 'OCUPADA' | 'OFFLINE' = busy.has(modelId)
      ? 'OCUPADA'
      : (await this.presence.getStatus(modelId)) === 'ONLINE'
        ? 'ONLINE'
        : 'OFFLINE';
    const isFavorite =
      requester.role === 'CLIENT'
        ? new Set(await this.favorites.listFavoriteModelIds(requester.id)).has(modelId)
        : false;
    return this.toCard(profile, status, isFavorite);
```

- [ ] **Step 5: Importar CallsModule no MarketplaceModule**

Modify `src/marketplace/marketplace.module.ts` — adicionar `import { CallsModule } from '../calls/calls.module';` e incluí-lo em `imports` (mantendo PrismaModule, AuthModule, UsersModule). Isso disponibiliza `CallService` para a `DiscoveryService`.

- [ ] **Step 6: Rodar a suíte completa e o tsc**

Run:
```bash
npm run test:int
npx tsc --noEmit
```
Expected: PASS — todas as suítes (incl. calls + discovery com OCUPADA). tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/calls/call.service.ts src/marketplace/discovery.service.ts src/marketplace/marketplace.module.ts test/discovery.e2e-spec.ts
git commit -m "feat(calls): OCUPADA in discovery (status ONLINE|OCUPADA|OFFLINE) via activeModelIds"
```

---

## Cobertura do spec (self-review)

| Requisito do spec (seção) | Onde é atendido |
|---|---|
| Entidade Call + estados (§4) | Task 1 + Tasks 3-5 (transições) |
| Ring/accept (§6.1-6.2) | Task 3 (initiate) + Task 4 (accept/reject) |
| Invariante 1-aberta-por-cliente/modelo via advisory lock (§2,§3) | Task 3 (`lock` + checks) + teste de concorrência |
| Re-check atômico no accept (§3,§6.2) | Task 4 (`accept`) + teste sem-saldo |
| Gate (online+saldo, 404/409/402/403) (§6.1,§7) | Task 3 + testes |
| pricePerMinuteSnapshot (§3) | Task 1 (campo) + Task 3 (captura) |
| Token de mídia via porta sob demanda (§5,§6.2,§6.6) | Task 2 (porta) + Task 4 (accept) + Task 5 (GET) |
| Timeout lazy 30s (§3,§6.2,§6.6) | Task 4 (accept) + Task 5 (getForParticipant) |
| hangup/panic (§6.4,§6.5) | Task 5 |
| endCall(reason) seam Billing (§6.7) | Task 5 |
| OCUPADA derivada + card status + sort (§6.8) | Task 6 |
| Sem ciclo (Calls não importa Marketplace) (§2) | Tasks 3,6 (Marketplace→Calls) |
| 402 via HttpException (§3) | Tasks 3,4 |
| Migração não-interativa (§3) | Task 1 |
| tsc/import type (§3) | Tasks 2-6 |

Sem placeholders. Tipos consistentes entre tasks: `CallService.initiate/accept/reject/hangup/panic/endCall/getForParticipant/activeModelIds`, `MediaServerProvider.issueToken`, `MediaToken`, `MEDIA_SERVER`, `ModelCard.status`, `lock`/`isExpired` usados igual onde produzidos e consumidos.
