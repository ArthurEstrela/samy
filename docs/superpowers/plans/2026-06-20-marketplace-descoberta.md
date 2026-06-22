# Marketplace & Descoberta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a vitrine da Samy — perfil da modelo (preço/min, tags, bio, preview de voz), presença em tempo real via Redis (ONLINE/OFFLINE com heartbeat), descoberta com filtro/ordenação online-first e favoritos do cliente.

**Architecture:** NestJS + Prisma + **Redis** (novo no stack) sobre o projeto existente. Presença vive só no Redis (chaves com TTL, sem estado preso no Postgres). A descoberta busca o conjunto candidato inteiro, enriquece com presença (MGET) e favoritos, ordena e pagina **em memória** (o SQL não sabe quem está online). Reusa os guards e papéis da Identidade; só modelo `ACTIVE` com perfil aparece (amarra com o KYC).

**Tech Stack:** NestJS, Prisma v5.22.0, PostgreSQL, Redis 7 via `ioredis`, Jest (integração contra Postgres + Redis reais, `npm run test:int`), supertest (e2e).

## Global Constraints

- **Presença só no Redis, com TTL** — chave `presence:model:<userId>`, TTL 30s; parar o heartbeat → OFFLINE automático. Nunca "online preso" no Postgres.
- **`REDIS_URL` por env, fail-fast no boot** se ausente. Dev usa db 0, teste usa db 1 (`redis://localhost:6379/1`).
- **`pricePerMinute` é `Decimal(14,2)` e > 0** (400 se ≤ 0); nunca float em aritmética. Retornado nos cards como string.
- **`voicePreviewUrl`, se presente, é URL http(s) válida** (400 se inválida).
- **Paginação da descoberta é em memória** (não no SQL): busca candidatos ACTIVE (teto `MAX_CANDIDATES = 5000`), MGET presença, ordena **ONLINE→favoritas→createdAt desc**, fatia `slice(offset, offset+limit)` (limit default 50, máx 100; offset default 0; limit fora do range → 400).
- **Visibilidade:** só `User.role=MODEL` + `status=ACTIVE` + com `ModelProfile` aparece na descoberta / `GET /models/:id`.
- **Conta da modelo:** `model:<userId>` (consistência), mas as chaves de presença usam o `userId` cru.
- **`npx tsc --noEmit` deve passar:** `import type` para interfaces em posição injetada (TS1272).
- **Migração não-interativa:** `prisma migrate diff` + `prisma migrate deploy`; SQL UTF-8 sem BOM; teste via `db:test:push`.
- **Append em `.env` SEMPRE com newline inicial** (`printf '\n...'`) — append sem newline cola na linha anterior e corrompe o valor (lição do KYC).
- **Não alterar tabelas do ledger/identidade/kyc.**

---

### Task 1: Infra Redis (compose + ioredis + RedisModule/RedisService + env)

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env`, `.env.test`
- Create: `src/redis/redis.service.ts`
- Create: `src/redis/redis.module.ts`
- Test: `test/redis.service.spec.ts`

**Interfaces:**
- Consumes: nada do projeto.
- Produces:
  - `RedisService` (`@Global` via `RedisModule`):
    - `setOnline(modelId: string): Promise<void>` — `SET presence:model:<id> ONLINE EX 30`.
    - `getStatus(modelId: string): Promise<'ONLINE' | 'OFFLINE'>`.
    - `getStatuses(modelIds: string[]): Promise<Record<string, 'ONLINE' | 'OFFLINE'>>` — um `MGET`.
    - `ttlOf(modelId: string): Promise<number>` — segundos restantes (-2 ausente, -1 sem TTL).
  - Construtor fail-fast se `REDIS_URL` ausente; conecta no `onModuleInit`, `quit` no `onModuleDestroy`.

- [ ] **Step 1: Subir o Redis no compose e instalar ioredis**

Modify `docker-compose.yml` — adicionar o serviço (junto dos postgres existentes):
```yaml
  redis:
    image: redis:7
    ports:
      - "6379:6379"
```
Run:
```bash
docker compose up -d
npm install ioredis
```

- [ ] **Step 2: Adicionar REDIS_URL aos envs (com newline inicial!)**

Run (Bash/Git Bash):
```bash
printf '\nREDIS_URL="redis://localhost:6379/0"\n' >> .env
printf '\nREDIS_URL="redis://localhost:6379/1"\n' >> .env.test
```
Confirme com `tail -2 .env.test` que `REDIS_URL` está em sua própria linha.

- [ ] **Step 3: Escrever o teste de integração (Redis real, db de teste)**

Create `test/redis.service.spec.ts`:
```typescript
import Redis from 'ioredis';
import { RedisService } from '../src/redis/redis.service';

describe('RedisService', () => {
  let service: RedisService;
  let raw: Redis;

  beforeAll(async () => {
    service = new RedisService();
    await service.onModuleInit();
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => { await raw.flushdb(); });
  afterAll(async () => {
    await service.onModuleDestroy();
    await raw.quit();
  });

  it('setOnline marca presença com TTL positivo', async () => {
    await service.setOnline('m1');
    expect(await service.getStatus('m1')).toBe('ONLINE');
    expect(await service.ttlOf('m1')).toBeGreaterThan(0);
  });

  it('getStatus é OFFLINE quando não há chave', async () => {
    expect(await service.getStatus('ghost')).toBe('OFFLINE');
  });

  it('getStatuses reflete um lote (MGET)', async () => {
    await service.setOnline('a');
    await service.setOnline('b');
    const s = await service.getStatuses(['a', 'b', 'c']);
    expect(s).toEqual({ a: 'ONLINE', b: 'ONLINE', c: 'OFFLINE' });
  });

  it('getStatuses([]) devolve objeto vazio sem chamar o Redis', async () => {
    expect(await service.getStatuses([])).toEqual({});
  });
});
```

- [ ] **Step 4: Rodar para ver falhar**

Run: `npm run test:int -- test/redis.service.spec.ts`
Expected: FAIL — `RedisService` inexistente.

- [ ] **Step 5: Implementar o RedisService**

Create `src/redis/redis.service.ts`:
```typescript
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

type Presence = 'ONLINE' | 'OFFLINE';
const TTL_SECONDS = 30;
const key = (modelId: string): string => `presence:model:${modelId}`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL env var is required');
    }
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async setOnline(modelId: string): Promise<void> {
    await this.client.set(key(modelId), 'ONLINE', 'EX', TTL_SECONDS);
  }

  async getStatus(modelId: string): Promise<Presence> {
    const v = await this.client.get(key(modelId));
    return v ? 'ONLINE' : 'OFFLINE';
  }

  async getStatuses(modelIds: string[]): Promise<Record<string, Presence>> {
    const out: Record<string, Presence> = {};
    if (modelIds.length === 0) {
      return out;
    }
    const values = await this.client.mget(...modelIds.map(key));
    modelIds.forEach((id, i) => {
      out[id] = values[i] ? 'ONLINE' : 'OFFLINE';
    });
    return out;
  }

  async ttlOf(modelId: string): Promise<number> {
    return this.client.ttl(key(modelId));
  }
}
```

Create `src/redis/redis.module.ts`:
```typescript
import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
```

- [ ] **Step 6: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/redis.service.spec.ts
npx tsc --noEmit
```
Expected: PASS (4 testes) e tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml src/redis test/redis.service.spec.ts package.json package-lock.json
git commit -m "feat(redis): RedisService presence (SETEX/MGET) + Redis infra"
```

---

### Task 2: Schema ModelProfile + Favorite

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260620040000_marketplace/migration.sql`
- Test: `test/marketplace-schema.spec.ts`

**Interfaces:**
- Consumes: `PrismaClient`.
- Produces: tabelas `model_profiles` (`userId` PK), `favorites` (unique `(clientUserId, modelUserId)`); tipos `ModelProfile`, `Favorite`.

- [ ] **Step 1: Escrever o teste que falha**

Create `test/marketplace-schema.spec.ts`:
```typescript
import { PrismaClient, Prisma } from '@prisma/client';

describe('marketplace schema', () => {
  const prisma = new PrismaClient();
  beforeEach(async () => {
    await prisma.favorite.deleteMany();
    await prisma.modelProfile.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it('cria perfil com tags (text[]) e preço decimal', async () => {
    const p = await prisma.modelProfile.create({
      data: { userId: 'u1', pricePerMinute: new Prisma.Decimal('5.00'), tags: ['voz-suave', 'noturno'] },
    });
    expect(p.tags).toEqual(['voz-suave', 'noturno']);
    expect(p.pricePerMinute.toString()).toBe('5');
  });

  it('rejeita favorito duplicado (mesmo cliente+modelo)', async () => {
    const base = { clientUserId: 'c1', modelUserId: 'm1' };
    await prisma.favorite.create({ data: base });
    await expect(prisma.favorite.create({ data: base })).rejects.toMatchObject({ code: 'P2002' });
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/marketplace-schema.spec.ts`
Expected: FAIL — `prisma.modelProfile` não existe.

- [ ] **Step 3: Adicionar os modelos ao schema**

Add to `prisma/schema.prisma` (após os modelos existentes):
```prisma
model ModelProfile {
  userId          String   @id
  bio             String?
  pricePerMinute  Decimal  @db.Decimal(14, 2)
  tags            String[]
  voicePreviewUrl String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([pricePerMinute])
  @@map("model_profiles")
}

model Favorite {
  id           String   @id @default(uuid())
  clientUserId String
  modelUserId  String
  createdAt    DateTime @default(now())

  @@unique([clientUserId, modelUserId])
  @@index([clientUserId])
  @@map("favorites")
}
```

- [ ] **Step 4: Gerar migration não-interativa e aplicar**

Run (Bash/Git Bash, para UTF-8 sem BOM):
```bash
mkdir -p prisma/migrations/20260620040000_marketplace
npx prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260620040000_marketplace/migration.sql
npx prisma generate
npx prisma migrate deploy
```
Confirme que o SQL tem `CREATE TABLE "model_profiles"` e `CREATE TABLE "favorites"` com `UNIQUE INDEX` em `(clientUserId, modelUserId)` e não dropa outras tabelas. Se houver P3018 (BOM), reescreva UTF-8 sem BOM.

- [ ] **Step 5: Rodar o teste**

Run: `npm run test:int -- test/marketplace-schema.spec.ts`
Expected: PASS (2 testes).

- [ ] **Step 6: Commit**

```bash
git add prisma test/marketplace-schema.spec.ts
git commit -m "feat(marketplace): ModelProfile and Favorite schema"
```

---

### Task 3: ProfileService + controller (/me/profile, /models/:id placeholder) + módulo

**Files:**
- Create: `src/marketplace/profile.service.ts`
- Create: `src/marketplace/profile.controller.ts`
- Create: `src/marketplace/dto.ts`
- Create: `src/marketplace/marketplace.module.ts`
- Modify: `src/app.module.ts`
- Test: `test/profile.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `JwtAuthGuard`/`RolesGuard`/`@Roles` (Identidade).
- Produces:
  - `ProfileService.upsert(userId, dto): Promise<ModelProfile>` — valida `pricePerMinute > 0` (`BadRequestException`) e `voicePreviewUrl` http(s) (`BadRequestException`).
  - `ProfileService.getOwn(userId): Promise<ModelProfile>` — `NotFoundException` se não existe.
  - `UpsertProfileDto = { bio?: string; pricePerMinute: string; tags?: string[]; voicePreviewUrl?: string }`.
  - `PUT /me/profile`, `GET /me/profile` (`@Roles('MODEL')`).
  - `MarketplaceModule` (imports PrismaModule, AuthModule; provê ProfileService; declara ProfileController). Registrado em `AppModule`.

- [ ] **Step 1: Escrever o teste e2e**

Create `test/profile.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Profile', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.favorite.deleteMany();
    await prisma.modelProfile.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<string> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return res.body.accessToken;
  }

  it('MODEL faz upsert e lê o próprio perfil', async () => {
    const token = await login('mod1', 'MODEL');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ bio: 'oi', pricePerMinute: '5.00', tags: ['noturno'], voicePreviewUrl: 'https://cdn.x/a.mp3' })
      .expect(200);
    const got = await http().get('/me/profile').set('Authorization', `Bearer ${token}`).expect(200);
    expect(got.body.pricePerMinute).toBe('5');
    expect(got.body.tags).toEqual(['noturno']);
  });

  it('GET /me/profile sem perfil → 404', async () => {
    const token = await login('mod2', 'MODEL');
    await http().get('/me/profile').set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('pricePerMinute <= 0 → 400; voicePreviewUrl inválida → 400', async () => {
    const token = await login('mod3', 'MODEL');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ pricePerMinute: '0' }).expect(400);
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`)
      .send({ pricePerMinute: '5.00', voicePreviewUrl: 'not-a-url' }).expect(400);
  });

  it('CLIENT em /me/profile → 403; sem token → 401', async () => {
    const token = await login('cli1', 'CLIENT');
    await http().put('/me/profile').set('Authorization', `Bearer ${token}`).send({ pricePerMinute: '5.00' }).expect(403);
    await http().get('/me/profile').expect(401);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/profile.e2e-spec.ts`
Expected: FAIL — rota `/me/profile` inexistente.

- [ ] **Step 3: Criar o DTO**

Create `src/marketplace/dto.ts`:
```typescript
export interface UpsertProfileDto {
  bio?: string;
  pricePerMinute: string;
  tags?: string[];
  voicePreviewUrl?: string;
}
```

- [ ] **Step 4: Implementar o ProfileService**

Create `src/marketplace/profile.service.ts`:
```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ModelProfile, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertProfileDto } from './dto';

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(userId: string, dto: UpsertProfileDto): Promise<ModelProfile> {
    let price: Prisma.Decimal;
    try {
      price = new Prisma.Decimal(dto.pricePerMinute);
    } catch {
      throw new BadRequestException('pricePerMinute must be a decimal');
    }
    if (!price.greaterThan(0)) {
      throw new BadRequestException('pricePerMinute must be > 0');
    }
    if (dto.voicePreviewUrl !== undefined && !this.isHttpUrl(dto.voicePreviewUrl)) {
      throw new BadRequestException('voicePreviewUrl must be an http(s) URL');
    }
    const tags = dto.tags ?? [];
    return this.prisma.modelProfile.upsert({
      where: { userId },
      create: { userId, bio: dto.bio, pricePerMinute: price, tags, voicePreviewUrl: dto.voicePreviewUrl },
      update: { bio: dto.bio, pricePerMinute: price, tags, voicePreviewUrl: dto.voicePreviewUrl },
    });
  }

  async getOwn(userId: string): Promise<ModelProfile> {
    const p = await this.prisma.modelProfile.findUnique({ where: { userId } });
    if (!p) {
      throw new NotFoundException('Profile not found');
    }
    return p;
  }

  private isHttpUrl(value: string): boolean {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 5: Implementar o controller + módulo + wiring**

Create `src/marketplace/profile.controller.ts`:
```typescript
import { Body, Controller, Get, HttpCode, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ProfileService } from './profile.service';
import { UpsertProfileDto } from './dto';

@Controller('me/profile')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class ProfileController {
  constructor(private readonly profiles: ProfileService) {}

  @Put()
  @HttpCode(200)
  async upsert(
    @Req() req: Request & { user: AuthUser },
    @Body() dto: UpsertProfileDto,
  ): Promise<unknown> {
    return this.profiles.upsert(req.user.id, dto);
  }

  @Get()
  async get(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    return this.profiles.getOwn(req.user.id);
  }
}
```

Create `src/marketplace/marketplace.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class MarketplaceModule {}
```

Modify `src/app.module.ts` — importar `RedisModule` (Task 1) e `MarketplaceModule`, mantendo todos os imports existentes:
```typescript
import { RedisModule } from './redis/redis.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
// ...adicionar RedisModule e MarketplaceModule ao array imports do @Module
```

> Nota: ao adicionar `RedisModule` ao `AppModule`, TODA a suíte e2e passa a exigir o Redis no ar (`docker compose up -d`). Garanta o container Redis rodando antes de `npm run test:int`.

- [ ] **Step 6: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/profile.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (4 testes) e tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/marketplace src/app.module.ts test/profile.e2e-spec.ts
git commit -m "feat(marketplace): ModelProfile upsert/get (/me/profile, MODEL-only) + module wiring"
```

---

### Task 4: PresenceService + heartbeat (/me/heartbeat)

**Files:**
- Create: `src/marketplace/presence.service.ts`
- Create: `src/marketplace/presence.controller.ts`
- Modify: `src/marketplace/marketplace.module.ts`
- Test: `test/presence.e2e-spec.ts`

**Interfaces:**
- Consumes: `RedisService` (Task 1); guards.
- Produces:
  - `PresenceService.heartbeat(modelId): Promise<void>`; `getStatus(modelId): Promise<'ONLINE'|'OFFLINE'>`; `getStatuses(ids): Promise<Record<string,'ONLINE'|'OFFLINE'>>`.
  - `POST /me/heartbeat` (`@Roles('MODEL')`) → `{ status: 'ONLINE', ttl: 30 }`.

- [ ] **Step 1: Escrever o teste e2e**

Create `test/presence.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';
import { PresenceService } from '../src/marketplace/presence.service';

describe('Presence', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;
  let presence: PresenceService;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    presence = mod.get(PresenceService);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
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

  it('heartbeat marca a modelo ONLINE; ao limpar a chave volta a OFFLINE', async () => {
    const { token, id } = await login('mod1', 'MODEL');
    await http().post('/me/heartbeat').set('Authorization', `Bearer ${token}`).expect(201);
    expect(await presence.getStatus(id)).toBe('ONLINE');
    await raw.del(`presence:model:${id}`); // simula expiração
    expect(await presence.getStatus(id)).toBe('OFFLINE');
  });

  it('CLIENT no /me/heartbeat → 403', async () => {
    const { token } = await login('cli1', 'CLIENT');
    await http().post('/me/heartbeat').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/presence.e2e-spec.ts`
Expected: FAIL — `PresenceService`/rota inexistentes.

- [ ] **Step 3: Implementar o PresenceService**

Create `src/marketplace/presence.service.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class PresenceService {
  constructor(private readonly redis: RedisService) {}

  heartbeat(modelId: string): Promise<void> {
    return this.redis.setOnline(modelId);
  }

  getStatus(modelId: string): Promise<'ONLINE' | 'OFFLINE'> {
    return this.redis.getStatus(modelId);
  }

  getStatuses(modelIds: string[]): Promise<Record<string, 'ONLINE' | 'OFFLINE'>> {
    return this.redis.getStatuses(modelIds);
  }
}
```

- [ ] **Step 4: Implementar o controller + registrar**

Create `src/marketplace/presence.controller.ts`:
```typescript
import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PresenceService } from './presence.service';

@Controller('me/heartbeat')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Post()
  async beat(@Req() req: Request & { user: AuthUser }): Promise<{ status: 'ONLINE'; ttl: number }> {
    await this.presence.heartbeat(req.user.id);
    return { status: 'ONLINE', ttl: 30 };
  }
}
```

Modify `src/marketplace/marketplace.module.ts` — adicionar `PresenceService` aos providers (e exports), `PresenceController` aos controllers. (RedisModule é `@Global`, então `RedisService` já é injetável.)

- [ ] **Step 5: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/presence.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (2 testes) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/marketplace/presence.service.ts src/marketplace/presence.controller.ts src/marketplace/marketplace.module.ts test/presence.e2e-spec.ts
git commit -m "feat(marketplace): presence heartbeat (/me/heartbeat) via Redis TTL"
```

---

### Task 5: FavoritesService + controller (/favorites)

**Files:**
- Create: `src/marketplace/favorites.service.ts`
- Create: `src/marketplace/favorites.controller.ts`
- Modify: `src/marketplace/marketplace.module.ts`
- Test: `test/favorites.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; guards.
- Produces:
  - `FavoritesService.favorite(clientId, modelId): Promise<void>` — `NotFoundException` se `modelId` não é um User MODEL; idempotente (duplicado é no-op).
  - `FavoritesService.unfavorite(clientId, modelId): Promise<void>` — idempotente.
  - `FavoritesService.listFavoriteModelIds(clientId): Promise<string[]>`.
  - `POST /favorites/:modelId`, `DELETE /favorites/:modelId`, `GET /favorites` (`@Roles('CLIENT')`). `GET /favorites` retorna os `userId`s favoritados (cards completos vêm na Task 6 via DiscoveryService — aqui retorna a lista de ids).

- [ ] **Step 1: Escrever o teste e2e**

Create `test/favorites.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Favorites', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.favorite.deleteMany();
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

  it('cliente favorita um modelo, lista e desfavorita (idempotente)', async () => {
    const model = await login('mod1', 'MODEL');
    const client = await login('cli1', 'CLIENT');
    await http().post(`/favorites/${model.id}`).set('Authorization', `Bearer ${client.token}`).expect(201);
    await http().post(`/favorites/${model.id}`).set('Authorization', `Bearer ${client.token}`).expect(201); // idempotente
    const list = await http().get('/favorites').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(list.body).toContain(model.id);
    await http().delete(`/favorites/${model.id}`).set('Authorization', `Bearer ${client.token}`).expect(200);
    const after = await http().get('/favorites').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(after.body).not.toContain(model.id);
  });

  it('favoritar um id que não é MODEL → 404', async () => {
    const client = await login('cli2', 'CLIENT');
    await http().post('/favorites/00000000-0000-0000-0000-000000000000').set('Authorization', `Bearer ${client.token}`).expect(404);
  });

  it('MODEL em /favorites → 403', async () => {
    const model = await login('mod2', 'MODEL');
    await http().get('/favorites').set('Authorization', `Bearer ${model.token}`).expect(403);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/favorites.e2e-spec.ts`
Expected: FAIL — rotas inexistentes.

- [ ] **Step 3: Implementar o FavoritesService**

Create `src/marketplace/favorites.service.ts`:
```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async favorite(clientId: string, modelId: string): Promise<void> {
    const model = await this.prisma.user.findUnique({ where: { id: modelId } });
    if (!model || model.role !== 'MODEL') {
      throw new NotFoundException('Model not found');
    }
    await this.prisma.favorite.upsert({
      where: { clientUserId_modelUserId: { clientUserId: clientId, modelUserId: modelId } },
      create: { clientUserId: clientId, modelUserId: modelId },
      update: {},
    });
  }

  async unfavorite(clientId: string, modelId: string): Promise<void> {
    await this.prisma.favorite.deleteMany({
      where: { clientUserId: clientId, modelUserId: modelId },
    });
  }

  async listFavoriteModelIds(clientId: string): Promise<string[]> {
    const rows = await this.prisma.favorite.findMany({
      where: { clientUserId: clientId },
      select: { modelUserId: true },
    });
    return rows.map((r) => r.modelUserId);
  }
}
```

> Nota: o nome do índice composto gerado pelo Prisma é `clientUserId_modelUserId`.

- [ ] **Step 4: Implementar o controller + registrar**

Create `src/marketplace/favorites.controller.ts`:
```typescript
import { Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { FavoritesService } from './favorites.service';

@Controller('favorites')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Post(':modelId')
  async add(@Req() req: Request & { user: AuthUser }, @Param('modelId') modelId: string): Promise<{ ok: true }> {
    await this.favorites.favorite(req.user.id, modelId);
    return { ok: true };
  }

  @Delete(':modelId')
  @HttpCode(200)
  async remove(@Req() req: Request & { user: AuthUser }, @Param('modelId') modelId: string): Promise<{ ok: true }> {
    await this.favorites.unfavorite(req.user.id, modelId);
    return { ok: true };
  }

  @Get()
  async list(@Req() req: Request & { user: AuthUser }): Promise<string[]> {
    return this.favorites.listFavoriteModelIds(req.user.id);
  }
}
```

Modify `src/marketplace/marketplace.module.ts` — adicionar `FavoritesService` aos providers (e exports) e `FavoritesController` aos controllers.

- [ ] **Step 5: Rodar o teste e o tsc**

Run:
```bash
npm run test:int -- test/favorites.e2e-spec.ts
npx tsc --noEmit
```
Expected: PASS (3 testes) e tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/marketplace/favorites.service.ts src/marketplace/favorites.controller.ts src/marketplace/marketplace.module.ts test/favorites.e2e-spec.ts
git commit -m "feat(marketplace): favorites (POST/DELETE/GET /favorites, CLIENT-only)"
```

---

### Task 6: DiscoveryService + controller (/models, /models/:id) + suíte completa

**Files:**
- Create: `src/marketplace/discovery.service.ts`
- Create: `src/marketplace/discovery.controller.ts`
- Modify: `src/marketplace/marketplace.module.ts`
- Test: `test/discovery.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `PresenceService` (Task 4), `FavoritesService` (Task 5); guards.
- Produces:
  - `ModelCard = { userId, displayName, bio, pricePerMinute, tags, voicePreviewUrl, isOnline, isFavorite }`.
  - `DiscoveryService.list({ tags?, limit, offset }, requester): Promise<ModelCard[]>` — busca ACTIVE-com-perfil (teto 5000), enriquece (presença + favoritos), ordena ONLINE→fav→createdAt desc, fatia.
  - `DiscoveryService.getOne(modelId, requester): Promise<ModelCard>` — `NotFoundException` se não ACTIVE-com-perfil.
  - `GET /models?tags=&limit=&offset=` e `GET /models/:id` (`@UseGuards(JwtAuthGuard)` — qualquer autenticado).

- [ ] **Step 1: Escrever o teste e2e**

Create `test/discovery.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Discovery', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeId: FakeIdentityProvider;
  let raw: Redis;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider)
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    fakeId = mod.get(IDENTITY_PROVIDER);
    raw = new Redis(process.env.REDIS_URL as string);
  });
  beforeEach(async () => {
    fakeId.reset();
    await raw.flushdb();
    await prisma.favorite.deleteMany();
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
  // cria um MODEL ACTIVE com perfil; retorna id. createdAt controlado para testar recência.
  async function makeModel(sub: string, opts: { tags?: string[]; createdAt?: Date } = {}): Promise<string> {
    const m = await login(sub, 'MODEL');
    await prisma.user.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
    await prisma.modelProfile.create({
      data: { userId: m.id, pricePerMinute: new Prisma.Decimal('5.00'), tags: opts.tags ?? [], createdAt: opts.createdAt ?? new Date() },
    });
    return m.id;
  }

  it('lista só ACTIVE-com-perfil (PENDING e sem-perfil não aparecem)', async () => {
    const active = await makeModel('a1');
    await login('p1', 'MODEL'); // PENDING_VERIFICATION, sem perfil
    const client = await login('c1', 'CLIENT');
    const res = await http().get('/models').set('Authorization', `Bearer ${client.token}`).expect(200);
    const ids = res.body.map((c: { userId: string }) => c.userId);
    expect(ids).toContain(active);
    expect(ids).toHaveLength(1);
  });

  it('filtra por tags (hasEvery)', async () => {
    const noturno = await makeModel('a2', { tags: ['noturno', 'voz-suave'] });
    await makeModel('a3', { tags: ['diurno'] });
    const client = await login('c2', 'CLIENT');
    const res = await http().get('/models?tags=noturno').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(res.body.map((c: { userId: string }) => c.userId)).toEqual([noturno]);
  });

  it('paradoxo paginação×presença: ONLINE antiga vem na página 1 antes de OFFLINE recentes', async () => {
    const onlineOld = await makeModel('old', { createdAt: new Date('2020-01-01') });
    await makeModel('new1', { createdAt: new Date('2026-01-01') });
    await makeModel('new2', { createdAt: new Date('2026-02-01') });
    await raw.set(`presence:model:${onlineOld}`, 'ONLINE', 'EX', 30);
    const client = await login('c3', 'CLIENT');
    const res = await http().get('/models?limit=1').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userId).toBe(onlineOld);
    expect(res.body[0].isOnline).toBe(true);
  });

  it('marca isFavorite para o cliente', async () => {
    const m = await makeModel('a4');
    const client = await login('c4', 'CLIENT');
    await http().post(`/favorites/${m}`).set('Authorization', `Bearer ${client.token}`).expect(201);
    const res = await http().get('/models').set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(res.body[0].isFavorite).toBe(true);
  });

  it('GET /models/:id ACTIVE → card; inexistente/PENDING → 404', async () => {
    const m = await makeModel('a5');
    const pending = await login('p2', 'MODEL');
    const client = await login('c5', 'CLIENT');
    const ok = await http().get(`/models/${m}`).set('Authorization', `Bearer ${client.token}`).expect(200);
    expect(ok.body.userId).toBe(m);
    await http().get(`/models/${pending.id}`).set('Authorization', `Bearer ${client.token}`).expect(404);
  });

  it('limit fora do range → 400', async () => {
    const client = await login('c6', 'CLIENT');
    await http().get('/models?limit=999').set('Authorization', `Bearer ${client.token}`).expect(400);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm run test:int -- test/discovery.e2e-spec.ts`
Expected: FAIL — rota `/models` inexistente.

- [ ] **Step 3: Implementar o DiscoveryService**

Create `src/marketplace/discovery.service.ts`:
```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from './presence.service';
import { FavoritesService } from './favorites.service';

const MAX_CANDIDATES = 5000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export interface ModelCard {
  userId: string;
  displayName: string;
  bio: string | null;
  pricePerMinute: string;
  tags: string[];
  voicePreviewUrl: string | null;
  isOnline: boolean;
  isFavorite: boolean;
}

interface Requester {
  id: string;
  role: string;
}

interface ListParams {
  tags?: string[];
  limit?: number;
  offset?: number;
}

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: PresenceService,
    private readonly favorites: FavoritesService,
  ) {}

  async list(params: ListParams, requester: Requester): Promise<ModelCard[]> {
    const limit = params.limit ?? DEFAULT_LIMIT;
    const offset = params.offset ?? 0;
    if (limit < 1 || limit > MAX_LIMIT || offset < 0) {
      throw new BadRequestException('invalid limit/offset');
    }

    const profiles = await this.prisma.modelProfile.findMany({
      where: params.tags && params.tags.length > 0 ? { tags: { hasEvery: params.tags } } : {},
      orderBy: { createdAt: 'desc' },
      take: MAX_CANDIDATES,
    });
    const ids = profiles.map((p) => p.userId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, role: 'MODEL', status: 'ACTIVE' },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const candidates = profiles.filter((p) => userById.has(p.userId));

    const presence = await this.presence.getStatuses(candidates.map((p) => p.userId));
    const favoriteIds =
      requester.role === 'CLIENT'
        ? new Set(await this.favorites.listFavoriteModelIds(requester.id))
        : new Set<string>();

    const cards = candidates.map((p) =>
      this.toCard(p, userById.get(p.userId)!.displayName, presence[p.userId] === 'ONLINE', favoriteIds.has(p.userId)),
    );

    cards.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      return 0; // candidates já vêm por createdAt desc; sort estável preserva
    });

    return cards.slice(offset, offset + limit);
  }

  async getOne(modelId: string, requester: Requester): Promise<ModelCard> {
    const profile = await this.prisma.modelProfile.findUnique({ where: { userId: modelId } });
    const user = await this.prisma.user.findUnique({ where: { id: modelId } });
    if (!profile || !user || user.role !== 'MODEL' || user.status !== 'ACTIVE') {
      throw new NotFoundException('Model not found');
    }
    const isOnline = (await this.presence.getStatus(modelId)) === 'ONLINE';
    const isFavorite =
      requester.role === 'CLIENT'
        ? (await this.favorites.listFavoriteModelIds(requester.id)).includes(modelId)
        : false;
    return this.toCard(profile, user.displayName, isOnline, isFavorite);
  }

  private toCard(
    p: { userId: string; bio: string | null; pricePerMinute: { toString(): string }; tags: string[]; voicePreviewUrl: string | null },
    displayName: string,
    isOnline: boolean,
    isFavorite: boolean,
  ): ModelCard {
    return {
      userId: p.userId,
      displayName,
      bio: p.bio,
      pricePerMinute: p.pricePerMinute.toString(),
      tags: p.tags,
      voicePreviewUrl: p.voicePreviewUrl,
      isOnline,
      isFavorite,
    };
  }
}
```

> Nota de ordenação: `Array.prototype.sort` é estável (V8). Como `candidates` já vêm `createdAt desc`, o comparador só reordena por ONLINE e favorito, preservando a recência como desempate — exatamente ONLINE→favorita→recente.

- [ ] **Step 4: Implementar o controller + registrar**

Create `src/marketplace/discovery.controller.ts`:
```typescript
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { DiscoveryService, ModelCard } from './discovery.service';

@Controller('models')
@UseGuards(JwtAuthGuard)
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get()
  async list(
    @Req() req: Request & { user: AuthUser },
    @Query('tags') tags?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ModelCard[]> {
    return this.discovery.list(
      {
        tags: tags ? tags.split(',').filter(Boolean) : undefined,
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined,
      },
      { id: req.user.id, role: req.user.role },
    );
  }

  @Get(':id')
  async getOne(
    @Req() req: Request & { user: AuthUser },
    @Param('id') id: string,
  ): Promise<ModelCard> {
    return this.discovery.getOne(id, { id: req.user.id, role: req.user.role });
  }
}
```

Modify `src/marketplace/marketplace.module.ts` — adicionar `DiscoveryService` aos providers e `DiscoveryController` aos controllers (o módulo já provê `PresenceService` e `FavoritesService`).

- [ ] **Step 5: Rodar a suíte completa e o tsc**

Run:
```bash
npm run test:int
npx tsc --noEmit
```
Expected: PASS — todas as suítes (ledger + identidade + kyc + marketplace). tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/marketplace/discovery.service.ts src/marketplace/discovery.controller.ts src/marketplace/marketplace.module.ts test/discovery.e2e-spec.ts
git commit -m "feat(marketplace): discovery (/models, /models/:id) with in-memory online-first sort+paginate"
```

---

## Cobertura do spec (self-review)

| Requisito do spec (seção) | Onde é atendido |
|---|---|
| Redis no stack + presença com TTL (§2,§5) | Task 1 (`RedisService`, compose, env) |
| `REDIS_URL` fail-fast (§3) | Task 1 (construtor lança) |
| ModelProfile (preço/min, tags, bio, voicePreviewUrl) (§4) | Task 2 + Task 3 |
| `pricePerMinute > 0`, `voicePreviewUrl` http(s) (§3,§7.1) | Task 3 (`ProfileService` valida) |
| Heartbeat ONLINE/OFFLINE, sem "online preso" (§3,§7.2) | Task 4 (`/me/heartbeat` + TTL) |
| Favoritos CLIENT, idempotente, 404 não-MODEL (§7.5) | Task 5 |
| Descoberta: só ACTIVE-com-perfil, tags, online-first, isOnline/isFavorite (§7.3) | Task 6 |
| Paginação em memória (paradoxo paginação×presença) (§3,§7.3) | Task 6 (`list` busca tudo, ordena, fatia) + teste do paradoxo |
| `limit` default 50/máx 100, offset (§3) | Task 6 (`list` valida) |
| `GET /models/:id` ACTIVE → card; senão 404 (§7.4) | Task 6 (`getOne`) |
| Visibilidade ACTIVE amarra com KYC (§2) | Task 6 (filtro `status=ACTIVE`) |
| Guards/papéis reusados (§6) | Tasks 3-6 (`@Roles` MODEL/CLIENT, JwtAuthGuard) |
| Append env com newline (§3) | Task 1 Step 2 (`printf '\n...'`) |
| Migração não-interativa UTF-8 (§3) | Task 2 |
| `tsc --noEmit` / `import type` (§3) | Tasks 1,3,4,5,6 |

Sem placeholders de implementação. Tipos consistentes entre tasks: `RedisService.setOnline/getStatus/getStatuses`, `PresenceService`, `FavoritesService.listFavoriteModelIds`, `ModelCard`, `UpsertProfileDto`, `accountOf`/`AuthUser` usados igual onde produzidos e consumidos.
