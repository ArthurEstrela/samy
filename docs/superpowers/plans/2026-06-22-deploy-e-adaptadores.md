# Deploy + Adaptadores sem-credencial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empacotar o backend Samy num artefato deployável (Docker + compose), blindar o boot (helmet/CORS/shutdown/`/health`), entregar o adaptador LiveKit real e garantir que nenhum adaptador *fake* seja default em produção.

**Architecture:** NestJS já modular com ports + adapters. Adicionamos um `HealthModule` (liveness Postgres+Redis), endurecemos `main.ts`, preenchemos o `LivekitMediaServer` com o `livekit-server-sdk` (lê env em runtime, boota sem chaves), trocamos o default do `PSP_PAYOUT_PORT` de fake → stub-que-lança, e criamos `Dockerfile`/`docker-compose.prod.yml`/`.env.example`/README.

**Tech Stack:** NestJS 11, Prisma 5.22, Postgres 16, Redis 7 (ioredis), `helmet`, `livekit-server-sdk`, Docker multi-stage.

## Global Constraints

- App **boota sem** `LIVEKIT_*`/PSP/KYC config — adaptadores reais leem env em runtime e falham com erro claro só quando usados.
- Fail-fast no boot **só** para os segredos já exigidos hoje: `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_CLIENT_ID`, `PSP_WEBHOOK_SECRET`, `KYC_WEBHOOK_SECRET`, `GLOBAL_TAKE_RATE`.
- **Nenhum `Fake*` adapter é default** de um módulo de produção. Fakes só via `.overrideProvider(...)` nos testes.
- `import type` para qualquer interface/porta injetada. `npx tsc --noEmit` limpo ao fim de cada task de código.
- Migração de produção via `prisma migrate deploy` (nunca `db push`/`migrate dev`) no entrypoint do container.
- Não alterar lógica de negócio dos 6 subsistemas — só infra, boot e troca de defaults.
- A suíte completa roda com `npm run test:int` (Postgres+Redis de teste no ar). Testes ficam em `test/*.spec.ts`.

---

## File Structure

```
src/health/health.controller.ts      GET /health (Postgres + Redis)  [novo]
src/health/health.module.ts          módulo do health                [novo]
src/redis/redis.service.ts           + ping()                        [modificado]
src/main.ts                          helmet, CORS, shutdown, port    [modificado]
src/app.module.ts                    importa HealthModule            [modificado]
src/calls/livekit-media-server.adapter.ts  LiveKit real              [modificado]
src/payout/real-psp-payout.adapter.ts      stub que lança            [novo]
src/payout/payout.module.ts          default = RealPspPayoutPort     [modificado]
test/health.spec.ts                  e2e /health + header helmet     [novo]
test/livekit-media-server.spec.ts    unit do adaptador LiveKit       [novo]
test/real-psp-payout.spec.ts         unit do stub                    [novo]
test/payout.processor.spec.ts        + override do fake              [modificado]
Dockerfile                           multi-stage                     [novo]
docker-entrypoint.sh                 migrate deploy + start          [novo]
.dockerignore                                                        [novo]
docker-compose.prod.yml              app + postgres + redis          [novo]
.env.example                         todas as env vars               [novo]
README-deploy.md                     passo-a-passo                   [novo]
package.json                         prisma → dependencies; helmet+sdk [modificado]
```

---

## Task 1: Endpoint `GET /health` (Postgres + Redis)

**Files:**
- Modify: `src/redis/redis.service.ts` (add `ping()`)
- Create: `src/health/health.controller.ts`
- Create: `src/health/health.module.ts`
- Modify: `src/app.module.ts` (import `HealthModule`)
- Test: `test/health.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (de `../prisma/prisma.service`), `RedisService` (de `../redis/redis.service`).
- Produces: `RedisService.ping(): Promise<boolean>`; rota `GET /health` → 200 `{status:'ok',postgres:'up',redis:'up'}` ou 503.

- [ ] **Step 1: Escrever o teste e2e que falha**

Create `test/health.spec.ts`:

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    app.use(helmet());
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it('retorna 200 com postgres e redis up', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', postgres: 'up', redis: 'up' });
  });

  it('aplica headers de segurança (helmet)', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-frame-options']).toBeDefined();
  });
});
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/health.spec.ts`
Expected: FAIL (rota `/health` inexistente → 404).

- [ ] **Step 3: Adicionar `ping()` ao RedisService**

In `src/redis/redis.service.ts`, add this method inside the class (after `ttlOf`):

```ts
  async ping(): Promise<boolean> {
    const res = await this.client.ping();
    return res === 'PONG';
  }
```

- [ ] **Step 4: Criar o HealthController**

Create `src/health/health.controller.ts`:

```ts
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async check(): Promise<{ status: string; postgres: string; redis: string }> {
    const postgres = await this.checkPostgres();
    const redis = await this.checkRedis();
    if (postgres !== 'up' || redis !== 'up') {
      throw new ServiceUnavailableException({ status: 'error', postgres, redis });
    }
    return { status: 'ok', postgres, redis };
  }

  private async checkPostgres(): Promise<string> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<string> {
    try {
      return (await this.redis.ping()) ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
}
```

- [ ] **Step 5: Criar o HealthModule**

Create `src/health/health.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { HealthController } from './health.controller';

@Module({
  imports: [PrismaModule],
  controllers: [HealthController],
})
export class HealthModule {}
```

(`RedisModule` é `@Global`, então `RedisService` é injetável sem import explícito.)

- [ ] **Step 6: Registrar no AppModule**

In `src/app.module.ts`, add the import line and the entry in the `imports` array:

```ts
import { HealthModule } from './health/health.module';
```

Add `HealthModule,` to the `imports: [...]` array (após `BillingModule`).

- [ ] **Step 7: Rodar o teste e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/health.spec.ts`
Expected: PASS (2 testes).

- [ ] **Step 8: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add src/health src/redis/redis.service.ts src/app.module.ts test/health.spec.ts
git commit -m "feat(health): GET /health (Postgres + Redis) + RedisService.ping"
```

---

## Task 2: Hardening do boot (`main.ts`)

**Files:**
- Modify: `package.json` (dependency `helmet`)
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `helmet` (default export).
- Produces: boot com `helmet()`, CORS configurável por `CORS_ORIGIN`, `enableShutdownHooks()`, porta por `PORT`. (O teste de header já existe em `test/health.spec.ts`, Task 1.)

- [ ] **Step 1: Instalar o helmet**

Run: `npm install helmet`
Expected: `helmet` aparece em `dependencies` do `package.json`.

- [ ] **Step 2: Endurecer o `main.ts`**

Replace the entire contents of `src/main.ts` with:

```ts
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(helmet());
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? true });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

- [ ] **Step 3: tsc limpo**

Run: `npx tsc --noEmit`
Expected: sem erros (se faltar tipo, `helmet` traz os próprios tipos).

- [ ] **Step 4: Rodar o teste de header**

Run: `npx jest --config ./jest-integration.json --runInBand test/health.spec.ts`
Expected: PASS (incl. "aplica headers de segurança (helmet)").

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/main.ts
git commit -m "feat(boot): helmet + CORS + shutdown hooks no bootstrap"
```

---

## Task 3: Adaptador LiveKit real

**Files:**
- Modify: `package.json` (dependency `livekit-server-sdk`)
- Modify: `src/calls/livekit-media-server.adapter.ts`
- Test: `test/livekit-media-server.spec.ts`

**Interfaces:**
- Consumes: `AccessToken` de `livekit-server-sdk`; env `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/`LIVEKIT_URL`.
- Produces: `LivekitMediaServer.issueToken(roomName, identity): Promise<{token,url}>` — assina JWT real; lança `Error('LiveKit not configured')` sem as 3 envs. (Implementa `MediaServerProvider` de `media-server.port.ts`, inalterado.)

- [ ] **Step 1: Instalar o SDK**

Run: `npm install livekit-server-sdk`
Expected: `livekit-server-sdk` em `dependencies`.

- [ ] **Step 2: Escrever o teste unit que falha**

Create `test/livekit-media-server.spec.ts`:

```ts
import { LivekitMediaServer } from '../src/calls/livekit-media-server.adapter';

describe('LivekitMediaServer', () => {
  const adapter = new LivekitMediaServer();
  const orig = { ...process.env };
  afterEach(() => { process.env = { ...orig }; });

  it('emite um JWT com a sala e a identidade quando configurado', async () => {
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secretsecretsecretsecretsecret123';
    process.env.LIVEKIT_URL = 'wss://example.livekit.cloud';
    const { token, url } = await adapter.issueToken('call:abc', 'user:1');
    expect(url).toBe('wss://example.livekit.cloud');
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    expect(payload.video.room).toBe('call:abc');
    expect(payload.sub).toBe('user:1');
  });

  it('lança erro claro quando não configurado', async () => {
    delete process.env.LIVEKIT_API_KEY;
    delete process.env.LIVEKIT_API_SECRET;
    delete process.env.LIVEKIT_URL;
    await expect(adapter.issueToken('r', 'i')).rejects.toThrow(/not configured/i);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/livekit-media-server.spec.ts`
Expected: FAIL (o adaptador atual sempre lança `'media server not configured'`, então o primeiro teste falha).

- [ ] **Step 4: Implementar o adaptador real**

Replace the entire contents of `src/calls/livekit-media-server.adapter.ts` with:

```ts
import { Injectable } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import type { MediaServerProvider, MediaToken } from './media-server.port';

@Injectable()
export class LivekitMediaServer implements MediaServerProvider {
  async issueToken(roomName: string, identity: string): Promise<MediaToken> {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
      throw new Error('LiveKit not configured');
    }
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({ roomJoin: true, room: roomName });
    const token = await at.toJwt();
    return { token, url };
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/livekit-media-server.spec.ts`
Expected: PASS (2 testes).

- [ ] **Step 6: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add package.json package-lock.json src/calls/livekit-media-server.adapter.ts test/livekit-media-server.spec.ts
git commit -m "feat(calls): adaptador LiveKit real (livekit-server-sdk), boota sem chaves"
```

---

## Task 4: Segurança de produção — PSP payout default não-fake

**Files:**
- Create: `src/payout/real-psp-payout.adapter.ts`
- Modify: `src/payout/payout.module.ts`
- Modify: `test/payout.processor.spec.ts` (override do fake)
- Test: `test/real-psp-payout.spec.ts`

**Interfaces:**
- Consumes: `PspPayoutPort` de `./psp-payout.port` (assinatura `sendPix(pixKey, amount, idempotencyKey): Promise<void>`).
- Produces: `RealPspPayoutPort implements PspPayoutPort` (lança `Error('PSP payout not configured')`); `PayoutModule` passa a prover `{ provide: PSP_PAYOUT_PORT, useClass: RealPspPayoutPort }`.

- [ ] **Step 1: Escrever o teste do stub que falha**

Create `test/real-psp-payout.spec.ts`:

```ts
import { RealPspPayoutPort } from '../src/payout/real-psp-payout.adapter';

describe('RealPspPayoutPort', () => {
  it('lança "not configured" enquanto não houver provedor plugado', async () => {
    const psp = new RealPspPayoutPort();
    await expect(psp.sendPix('chave', '100', 'id-1')).rejects.toThrow(/not configured/i);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/real-psp-payout.spec.ts`
Expected: FAIL (módulo `real-psp-payout.adapter` inexistente).

- [ ] **Step 3: Criar o adaptador real (stub que lança)**

Create `src/payout/real-psp-payout.adapter.ts`:

```ts
import { Injectable } from '@nestjs/common';
import type { PspPayoutPort } from './psp-payout.port';

// Ponto-de-plugar do PSP de saque (cash-out PIX). Enquanto não houver provedor
// (Suitpay/Pushin/etc.) configurado, lança erro claro — NUNCA finge pagar.
@Injectable()
export class RealPspPayoutPort implements PspPayoutPort {
  async sendPix(_pixKey: string, _amount: string, _idempotencyKey: string): Promise<void> {
    throw new Error('PSP payout not configured');
  }
}
```

- [ ] **Step 4: Trocar o default no PayoutModule**

In `src/payout/payout.module.ts`, replace the fake import + provider. Change:

```ts
import { FakePspPayoutPort } from './fake-psp-payout.adapter';
```
to:
```ts
import { RealPspPayoutPort } from './real-psp-payout.adapter';
```

and change the provider line:
```ts
    { provide: PSP_PAYOUT_PORT, useClass: FakePspPayoutPort },
```
to:
```ts
    { provide: PSP_PAYOUT_PORT, useClass: RealPspPayoutPort },
```

- [ ] **Step 5: Manter o teste do processor verde via override do fake**

In `test/payout.processor.spec.ts`, change the module compile (lines ~22-24) from:

```ts
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, KycModule, PayoutModule],
    }).compile();
```
to:
```ts
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LedgerModule, KycModule, PayoutModule],
    })
      .overrideProvider(PSP_PAYOUT_PORT)
      .useClass(FakePspPayoutPort)
      .compile();
```

(`PSP_PAYOUT_PORT` e `FakePspPayoutPort` já estão importados nesse arquivo.)

- [ ] **Step 6: Rodar os testes envolvidos**

Run: `npx jest --config ./jest-integration.json --runInBand test/real-psp-payout.spec.ts test/payout.processor.spec.ts test/payout.request.spec.ts`
Expected: PASS em todos (stub lança; processor usa o fake via override; request nunca chama o PSP).

- [ ] **Step 7: tsc limpo e commit**

Run: `npx tsc --noEmit`
Expected: sem erros.

```bash
git add src/payout/real-psp-payout.adapter.ts src/payout/payout.module.ts test/real-psp-payout.spec.ts test/payout.processor.spec.ts
git commit -m "fix(payout): default de produção é RealPspPayoutPort (não finge pagar); fake só em teste"
```

---

## Task 5: Containerização + env template + README

**Files:**
- Modify: `package.json` (mover `prisma` para `dependencies`)
- Create: `Dockerfile`
- Create: `docker-entrypoint.sh`
- Create: `.dockerignore`
- Create: `docker-compose.prod.yml`
- Create: `.env.example`
- Create: `README-deploy.md`

**Interfaces:**
- Consumes: `npm run build` (gera `dist/`), `prisma migrate deploy`, `node dist/main.js`.
- Produces: imagem que roda migrate e sobe a app na porta 3000; compose com Postgres+Redis saudáveis.

- [ ] **Step 1: Mover `prisma` para dependencies**

O entrypoint roda `prisma migrate deploy` em produção, então o CLI `prisma` precisa existir após `npm ci --omit=dev`. In `package.json`, remove `"prisma": "^5.22.0"` from `devDependencies` and add it to `dependencies` (mantendo a versão `^5.22.0`).

- [ ] **Step 2: Criar o `.dockerignore`**

Create `.dockerignore`:

```
node_modules
dist
coverage
.git
.env
.env.test
docs
test
*.md
.superpowers
```

- [ ] **Step 3: Criar o entrypoint**

Create `docker-entrypoint.sh` (LF, sem BOM):

```sh
#!/bin/sh
set -e
npx prisma migrate deploy
exec node dist/main.js
```

- [ ] **Step 4: Criar o Dockerfile**

Create `Dockerfile`:

```dockerfile
# --- build ---
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate
COPY . .
RUN npm run build

# --- runtime ---
FROM node:22-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
```

- [ ] **Step 5: Criar o `docker-compose.prod.yml`**

Create `docker-compose.prod.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: samy
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: samy
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U samy"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  app:
    build: .
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    ports:
      - "3000:3000"
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

- [ ] **Step 6: Criar o `.env.example`**

Create `.env.example`:

```bash
# ===== Obrigatórias no boot (app não sobe sem) =====
# Em docker-compose use os hostnames dos serviços: postgres / redis
DATABASE_URL="postgresql://samy:CHANGE_ME@postgres:5432/samy?schema=public"
REDIS_URL="redis://redis:6379"
JWT_ACCESS_SECRET="CHANGE_ME_access"
JWT_REFRESH_SECRET="CHANGE_ME_refresh"
GOOGLE_CLIENT_ID="CHANGE_ME.apps.googleusercontent.com"
PSP_WEBHOOK_SECRET="CHANGE_ME"      # HMAC do webhook de confirmação de recarga (cash-in)
KYC_WEBHOOK_SECRET="CHANGE_ME"      # HMAC do webhook do provedor de KYC
GLOBAL_TAKE_RATE="0.40"             # comissão padrão da plataforma (0..1)

# ===== Senha do Postgres no docker-compose.prod.yml =====
POSTGRES_PASSWORD="CHANGE_ME"

# ===== Opcionais / com default =====
ACCESS_TTL="15m"
REFRESH_TTL="30d"
MIN_PAYOUT="200"
PORT="3000"
CORS_ORIGIN="*"                     # restrinja ao domínio do front em produção

# ===== Pontos-de-plugar (app boota sem; falha só ao usar a feature) =====
# LiveKit (mídia das chamadas) — crie em https://cloud.livekit.io
LIVEKIT_API_KEY=""
LIVEKIT_API_SECRET=""
LIVEKIT_URL=""                      # ex: wss://seu-projeto.livekit.cloud
# PSP de saque (cash-out PIX): RealPspPayoutPort hoje lança "not configured".
#   Plugar quando escolher provedor (Suitpay/Pushin). Vars do provedor entram aqui.
# KYC (verificação de identidade): RealKycVerificationProvider hoje lança erro.
#   Plugar quando escolher provedor. Vars do provedor entram aqui.
```

- [ ] **Step 7: Criar o `README-deploy.md`**

Create `README-deploy.md`:

````markdown
# Deploy — Samy backend

Backend NestJS empacotado em Docker. Roda em qualquer host com Docker + Compose.

## Pré-requisitos
- Docker + Docker Compose v2
- Um arquivo `.env` na raiz (copie de `.env.example` e preencha)

## Subir
```bash
cp .env.example .env   # edite os CHANGE_ME
docker compose -f docker-compose.prod.yml up -d --build
```
O entrypoint roda `prisma migrate deploy` automaticamente antes de subir a app.

## Verificar
```bash
curl http://localhost:3000/health
# -> {"status":"ok","postgres":"up","redis":"up"}
```

## Variáveis de ambiente
Veja `.env.example`. Obrigatórias no boot: `DATABASE_URL`, `REDIS_URL`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_CLIENT_ID`, `PSP_WEBHOOK_SECRET`,
`KYC_WEBHOOK_SECRET`, `GLOBAL_TAKE_RATE`. As demais têm default ou são pontos-de-plugar.

## Adaptadores externos (plugar depois)
- **LiveKit** (mídia): preencha `LIVEKIT_API_KEY/SECRET/URL`. Sem isso, iniciar
  chamada falha com `LiveKit not configured` — o resto do app funciona.
- **PSP cash-out** (saque PIX): `RealPspPayoutPort` lança `PSP payout not configured`
  até plugar um provedor. Saques ficam PENDING e falham ao processar.
- **KYC**: `RealKycVerificationProvider` lança erro até plugar um provedor.

## Migrações
Geradas no repo em `prisma/migrations`. O container aplica com `migrate deploy`.
Nunca rode `db push`/`migrate dev` em produção.
````

- [ ] **Step 8: Buildar a imagem (verificação de infra)**

Run: `docker build -t samy-backend .`
Expected: build conclui sem erro; estágio runtime gera a imagem.

> Se o Docker Desktop não estiver rodando, suba-o antes. Esta verificação substitui o teste automatizado para os artefatos de infra (Dockerfile/compose/env), que não são testáveis via Jest.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile docker-entrypoint.sh .dockerignore docker-compose.prod.yml .env.example README-deploy.md package.json package-lock.json
git commit -m "feat(deploy): Dockerfile multi-stage + compose de produção + .env.example + README"
```

---

## Task 6: Verificação final (suíte completa + auditoria de defaults)

**Files:** nenhum (verificação).

- [ ] **Step 1: Rodar a suíte completa**

Run: `npm run test:int`
Expected: todas as suítes verdes (as anteriores + health, livekit, real-psp; payout via override).

- [ ] **Step 2: tsc final**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 3: Auditoria — nenhum `Fake*`/stub-fake é default de produção**

Run: `grep -rn "useClass:" src --include=*.module.ts`
Expected: confirmar que cada `provide: *_PORT/PROVIDER` aponta para o adaptador real
(`GoogleIdentityProvider`, `RealKycVerificationProvider`, `LivekitMediaServer`,
`RealPspPayoutPort`) — nenhum `Fake*`.

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review (autor)

**Cobertura do spec:**
- §1 Containerização → Task 5. ✓
- §1 `.env.example` → Task 5 Step 6. ✓
- §1 Hardening boot (helmet/CORS/shutdown/port) → Task 2. ✓
- §1 `GET /health` (Postgres+Redis) → Task 1. ✓
- §1 LiveKit real → Task 3. ✓
- §1 Auditoria PSP default + nenhum fake default → Task 4 + Task 6 Step 3. ✓
- §5.3 mantém `{ rawBody: true }` → Task 2 Step 2 preserva. ✓
- §5.4 503 quando cai → HealthController lança `ServiceUnavailableException`. ✓
- §7 Testes (health e2e, livekit unit, payout verde, suíte completa) → Tasks 1/3/4/6. ✓
- §7 Infra verificada por build → Task 5 Step 8. ✓

**Consistência de tipos:** `RedisService.ping(): Promise<boolean>` (def. Task 1, usado em HealthController Task 1). `RealPspPayoutPort.sendPix(pixKey,amount,idempotencyKey)` casa com `PspPayoutPort`. `LivekitMediaServer.issueToken(roomName,identity)` casa com `MediaServerProvider`.

**Placeholders:** nenhum — todo passo tem código/comando concreto.

**Nota de escopo:** PSP/KYC HTTP de provedor, QR PIX de cash-in e agendadores ficam fora (documentados como pontos-de-plugar no `.env.example`/README) — coerente com o spec.
