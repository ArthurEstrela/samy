# Ranking & Tiers (gamificação) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar às modelos um tier por desempenho (ganho bruto vitalício) que reduz a comissão da plataforma conforme sobem, com painel de progresso e leaderboard público.

**Architecture:** Lógica de tier é uma função pura sobre o ganho bruto agregado do ledger (`model:${id}`, entradas positivas). Um `RankingService` agrega e expõe via `GET /ranking/me` e `GET /ranking/top`. O Billing passa a usar a taxa do tier como *fallback* da takeRate (override manual do admin ainda vence). Frontend mostra um `TierBadge` no painel da modelo e uma página de leaderboard.

**Tech Stack:** NestJS + Prisma + Postgres (back); Vite + React 18 + TanStack Query v5 + Vitest (front). Decimais via `Prisma.Decimal`.

## Global Constraints

- Score = **ganho bruto vitalício**: `sum(LedgerEntry.amount)` onde `account = model:${id}` e `amount > 0`. Saques (negativos) **não** reduzem o score.
- Thresholds default (créditos): BRONZE ≥0; PRATA ≥500; OURO ≥2000; DIAMANTE ≥10000. Env `RANKING_THRESHOLDS`/`RANKING_RATES` sobrescrevem; ausentes/malformadas → defaults (warn, sem crash).
- **Taxas:** BRONZE = `GLOBAL_TAKE_RATE` (sem regressão pra modelo nova); PRATA/OURO/DIAMANTE = `min(global, 0.25/0.20/0.15)`. Subir de tier nunca aumenta a comissão. A tabela é construída passando o `GLOBAL_TAKE_RATE` — `loadTierTable(globalRate, env)`.
- takeRate efetiva: `override manual (admin) → taxa do tier → global`. Implementar via `resolveTakeRate(profile?.takeRate ?? null, tierRate)`.
- Imutabilidade do ledger: só cobranças futuras usam o tier atual; splits passados não mudam.
- Anonimato: leaderboard expõe só `stageName` + tier + posição; **nunca** `displayName` nem valores. `GET /ranking/me` expõe `earned` só pra própria modelo.
- `import type` em imports de tipo. Backend gate: `npx tsc --noEmit`. Front gate: `npm run build` (tsc -b, erasableSyntaxOnly + noUnusedLocals + strict). Front testa com boundary (`fetch`) mockado; `apiFetch` manda `method:'GET'` explícito quando sem método.
- Decimais comparados/somados com a API do `Prisma.Decimal` (`.gt`, `.gte`, `.add`, `.mul`), nunca com `>`/`+` de number.

---

### Task 1: Lógica pura de tier (`ranking.ts`)

**Files:**
- Create: `src/ranking/ranking.ts`
- Test: `src/ranking/ranking.spec.ts`

**Interfaces:**
- Consumes: `Prisma.Decimal` de `@prisma/client`.
- Produces:
  - `type Tier = 'BRONZE' | 'PRATA' | 'OURO' | 'DIAMANTE'`
  - `interface TierInfo { tier: Tier; rate: Prisma.Decimal; nextTier: Tier | null; nextThreshold: Prisma.Decimal | null; remaining: Prisma.Decimal | null }`
  - `function loadTierTable(globalRate: Prisma.Decimal, env?: NodeJS.ProcessEnv): TierRow[]` (asc por `min`; BRONZE rate = `globalRate`, demais `min(globalRate, default/env)`; defaults com warn se env malformada)
  - `function tierForEarnings(earned: Prisma.Decimal, table: TierRow[]): TierInfo`

- [ ] **Step 1: Write the failing test**

```ts
import { Prisma } from '@prisma/client';
import { tierForEarnings, loadTierTable } from './ranking';

const D = (n: string | number): Prisma.Decimal => new Prisma.Decimal(n);
const TABLE = loadTierTable(D('0.30')); // global = 0.30 → BRONZE 0.30

describe('tierForEarnings (global 0.30)', () => {
  it('ganho 0 → BRONZE (= global), próximo PRATA a 500, faltam 500', () => {
    const r = tierForEarnings(D(0), TABLE);
    expect(r.tier).toBe('BRONZE');
    expect(r.rate.equals(D('0.30'))).toBe(true);
    expect(r.nextTier).toBe('PRATA');
    expect(r.nextThreshold?.equals(D(500))).toBe(true);
    expect(r.remaining?.equals(D(500))).toBe(true);
  });

  it('logo abaixo do limite continua no tier de baixo', () => {
    expect(tierForEarnings(D('499.99'), TABLE).tier).toBe('BRONZE');
  });

  it('exatamente no limite sobe de tier (PRATA = min(0.30,0.25) = 0.25)', () => {
    const r = tierForEarnings(D(500), TABLE);
    expect(r.tier).toBe('PRATA');
    expect(r.rate.equals(D('0.25'))).toBe(true);
  });

  it('OURO em 2000', () => {
    expect(tierForEarnings(D(2000), TABLE).tier).toBe('OURO');
  });

  it('DIAMANTE em 10000 é tier máximo (sem próximo)', () => {
    const r = tierForEarnings(D(10000), TABLE);
    expect(r.tier).toBe('DIAMANTE');
    expect(r.rate.equals(D('0.15'))).toBe(true);
    expect(r.nextTier).toBeNull();
    expect(r.nextThreshold).toBeNull();
    expect(r.remaining).toBeNull();
  });

  it('BRONZE herda a taxa global (global 0.40 → BRONZE 0.40)', () => {
    const t = loadTierTable(D('0.40'));
    expect(tierForEarnings(D(0), t).rate.equals(D('0.40'))).toBe(true);
    // tiers acima são capados por min(global, default): 0.25/0.20/0.15
    expect(tierForEarnings(D(500), t).rate.equals(D('0.25'))).toBe(true);
  });

  it('global menor que todos os defaults nunca aumenta a comissão', () => {
    const t = loadTierTable(D('0.10'));
    expect(tierForEarnings(D(0), t).rate.equals(D('0.10'))).toBe(true);
    expect(tierForEarnings(D(10000), t).rate.equals(D('0.10'))).toBe(true); // min(0.10,0.15)
  });

  it('env malformada → cai nos defaults', () => {
    const table = loadTierTable(D('0.30'), { RANKING_THRESHOLDS: 'xyz' } as NodeJS.ProcessEnv);
    expect(table[0].rate.equals(D('0.30'))).toBe(true);
    expect(table).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/ranking/ranking.spec.ts`
Expected: FAIL ("Cannot find module './ranking'").

- [ ] **Step 3: Write the implementation**

```ts
import { Prisma } from '@prisma/client';

export type Tier = 'BRONZE' | 'PRATA' | 'OURO' | 'DIAMANTE';

export interface TierRow {
  tier: Tier;
  min: Prisma.Decimal;
  rate: Prisma.Decimal;
}

export interface TierInfo {
  tier: Tier;
  rate: Prisma.Decimal;
  nextTier: Tier | null;
  nextThreshold: Prisma.Decimal | null;
  remaining: Prisma.Decimal | null;
}

const TIER_ORDER: Tier[] = ['BRONZE', 'PRATA', 'OURO', 'DIAMANTE'];
const DEFAULT_THRESHOLDS = [0, 500, 2000, 10000];
// Taxas-alvo dos tiers acima de BRONZE; BRONZE herda o globalRate.
const DEFAULT_RATES = ['0.30', '0.25', '0.20', '0.15'];

function parseList(raw: string | undefined, expected: number): string[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== expected || parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  return parts;
}

export function loadTierTable(globalRate: Prisma.Decimal, env: NodeJS.ProcessEnv = process.env): TierRow[] {
  const thresholds = parseList(env.RANKING_THRESHOLDS, 4);
  const rates = parseList(env.RANKING_RATES, 4);
  if ((env.RANKING_THRESHOLDS && !thresholds) || (env.RANKING_RATES && !rates)) {
    // eslint-disable-next-line no-console
    console.warn('RANKING_THRESHOLDS/RANKING_RATES malformado — usando defaults.');
  }
  const th = thresholds ?? DEFAULT_THRESHOLDS.map(String);
  const rt = rates ?? DEFAULT_RATES;
  return TIER_ORDER.map((tier, i) => {
    // BRONZE (i=0) usa o globalRate; demais usam a taxa-alvo, sempre capada por
    // min(global, alvo) pra subir de tier nunca aumentar a comissão.
    const target = i === 0 ? globalRate : new Prisma.Decimal(rt[i]);
    const rate = Prisma.Decimal.min(globalRate, target);
    return { tier, min: new Prisma.Decimal(th[i]), rate };
  });
}

export function tierForEarnings(earned: Prisma.Decimal, table: TierRow[]): TierInfo {
  let idx = 0;
  for (let i = 0; i < table.length; i++) {
    if (earned.gte(table[i].min)) idx = i;
  }
  const row = table[idx];
  const next = idx + 1 < table.length ? table[idx + 1] : null;
  return {
    tier: row.tier,
    rate: row.rate,
    nextTier: next ? next.tier : null,
    nextThreshold: next ? next.min : null,
    remaining: next ? next.min.minus(earned) : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/ranking/ranking.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Backend typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ranking/ranking.ts src/ranking/ranking.spec.ts
git commit -m "feat(ranking): lógica pura de tier por ganho bruto"
```

---

### Task 2: RankingService + controller + module + endpoints

**Files:**
- Create: `src/ranking/ranking.service.ts`
- Create: `src/ranking/ranking.controller.ts`
- Create: `src/ranking/ranking.module.ts`
- Modify: `src/app.module.ts` (importar `RankingModule`)
- Test: `test/ranking.e2e-spec.ts`

**Interfaces:**
- Consumes: `tierForEarnings`, `loadTierTable`, `TierInfo`, `Tier` de `./ranking`; `PrismaService`; `JwtAuthGuard`/`RolesGuard`/`Roles('MODEL')` (mesmo padrão de `gifts.controller.ts`).
- Produces:
  - `RankingService.grossEarned(modelId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal>`
  - `RankingService.tierRateFor(modelId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal>` (a `rate` do tier; usada pelo Billing na Task 3)
  - `RankingService.myRanking(modelId): Promise<{ tier: Tier; earned: string; takeRate: string; nextTier: Tier | null; nextThreshold: string | null; remaining: string | null }>`
  - `RankingService.top(limit: number): Promise<{ rank: number; modelId: string; stageName: string; tier: Tier }[]>`
  - Rotas: `GET /ranking/me` (`@Roles('MODEL')`), `GET /ranking/top?limit=` (qualquer autenticado).

- [ ] **Step 1: Write the failing e2e test**

Harness idêntico ao `test/gifts.e2e-spec.ts` (FakeIdentityProvider, `/auth/google` com role → `res.body.accessToken` e `res.body.user.id`; ledger via `LedgerService`).

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Ranking (e2e)', () => {
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
  // ganho bruto histórico pra modelo (entrada positiva isolada, soma-zero com um sink)
  async function earn(modelId: string, amount: string, ref: string): Promise<void> {
    await ledger.postTransaction(`seed-earn:${ref}`, [
      { account: `model:${modelId}`, entryType: 'GANHO_MIN', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  async function profile(modelId: string, stageName: string): Promise<void> {
    await prisma.modelProfile.create({ data: { userId: modelId, stageName, pricePerMinute: new Prisma.Decimal('5.00'), tags: [] } });
  }

  it('GET /ranking/me reflete o tier pelo ganho bruto', async () => {
    const m = await login('m1', 'MODEL');
    await profile(m.id, 'Lara');
    await earn(m.id, '800.00', 'm1'); // >= 500 → PRATA
    const res = await http().get('/ranking/me').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.tier).toBe('PRATA');
    expect(res.body.earned).toBe('800.00');
    expect(res.body.nextTier).toBe('OURO');
  });

  it('GET /ranking/me por não-modelo → 403', async () => {
    const c = await login('c1', 'CLIENT');
    await http().get('/ranking/me').set('Authorization', `Bearer ${c.token}`).expect(403);
  });

  it('GET /ranking/top ordena por ganho desc e não vaza displayName/valores', async () => {
    const a = await login('ma', 'MODEL'); await profile(a.id, 'Lara'); await earn(a.id, '3000.00', 'ma');
    const b = await login('mb', 'MODEL'); await profile(b.id, 'Bianca'); await earn(b.id, '600.00', 'mb');
    const c = await login('c2', 'CLIENT');
    const res = await http().get('/ranking/top?limit=10').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].stageName).toBe('Lara'); // maior ganho primeiro
    expect(res.body[0].rank).toBe(1);
    expect(res.body[0].tier).toBe('OURO');
    expect(res.body[0]).not.toHaveProperty('displayName');
    expect(res.body[0]).not.toHaveProperty('earned');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

> Os e2e/integração rodam via `jest-integration.json` (carrega `.env.test` com `GLOBAL_TAKE_RATE=0.40` e usa o Postgres de teste). Garanta o banco de teste no ar: `docker compose up -d` + `npm run db:test:push` (uma vez).

Run: `npx jest --config ./jest-integration.json --runInBand test/ranking.e2e-spec.ts`
Expected: FAIL (rotas não existem → 404 / 403).

- [ ] **Step 3: Implement `ranking.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Tier, TierRow, loadTierTable, tierForEarnings } from './ranking';

@Injectable()
export class RankingService {
  private readonly table: TierRow[];

  constructor(private readonly prisma: PrismaService) {
    const raw = process.env.GLOBAL_TAKE_RATE;
    if (!raw) throw new Error('GLOBAL_TAKE_RATE env var is required');
    this.table = loadTierTable(new Prisma.Decimal(raw));
  }

  async grossEarned(modelId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const client = tx ?? this.prisma;
    const r = await client.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { account: `model:${modelId}`, amount: { gt: 0 } },
    });
    return r._sum.amount ?? new Prisma.Decimal(0);
  }

  async tierRateFor(modelId: string, tx?: Prisma.TransactionClient): Promise<Prisma.Decimal> {
    const earned = await this.grossEarned(modelId, tx);
    return tierForEarnings(earned, this.table).rate;
  }

  async myRanking(modelId: string): Promise<{
    tier: Tier; earned: string; takeRate: string;
    nextTier: Tier | null; nextThreshold: string | null; remaining: string | null;
  }> {
    const earned = await this.grossEarned(modelId);
    const info = tierForEarnings(earned, this.table);
    return {
      tier: info.tier,
      earned: earned.toFixed(2),
      takeRate: info.rate.toString(),
      nextTier: info.nextTier,
      nextThreshold: info.nextThreshold ? info.nextThreshold.toFixed(2) : null,
      remaining: info.remaining ? info.remaining.toFixed(2) : null,
    };
  }

  async top(limit: number): Promise<{ rank: number; modelId: string; stageName: string; tier: Tier }[]> {
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['account'],
      where: { account: { startsWith: 'model:' }, amount: { gt: 0 } },
      _sum: { amount: true },
    });
    const ranked = grouped
      .map((g) => ({ modelId: g.account.slice('model:'.length), earned: g._sum.amount ?? new Prisma.Decimal(0) }))
      .sort((a, b) => b.earned.comparedTo(a.earned))
      .slice(0, limit);
    if (ranked.length === 0) return [];
    const profiles = await this.prisma.modelProfile.findMany({
      where: { userId: { in: ranked.map((r) => r.modelId) } },
      select: { userId: true, stageName: true },
    });
    const nameOf = new Map(profiles.map((p) => [p.userId, p.stageName]));
    return ranked
      .filter((r) => nameOf.has(r.modelId))
      .map((r, i) => ({
        rank: i + 1,
        modelId: r.modelId,
        stageName: nameOf.get(r.modelId) as string,
        tier: tierForEarnings(r.earned, this.table).tier,
      }));
  }
}
```

- [ ] **Step 4: Implement `ranking.controller.ts`**

```ts
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { RankingService } from './ranking.service';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

@Controller('ranking')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RankingController {
  constructor(private readonly ranking: RankingService) {}

  @Get('me')
  @Roles('MODEL')
  async me(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    return this.ranking.myRanking(req.user.id);
  }

  @Get('top')
  async top(@Query('limit') limitRaw?: string): Promise<unknown> {
    const n = Number(limitRaw);
    const limit = Number.isFinite(n) && n >= 1 && n <= MAX_LIMIT ? Math.floor(n) : DEFAULT_LIMIT;
    return this.ranking.top(limit);
  }
}
```

- [ ] **Step 5: Implement `ranking.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { RankingService } from './ranking.service';
import { RankingController } from './ranking.controller';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [RankingController],
  providers: [RankingService],
  exports: [RankingService],
})
export class RankingModule {}
```

> Confira em `gifts.controller.ts`/`billing.module.ts` se `JwtAuthGuard`/`RolesGuard` exigem `AuthModule`/`UsersModule` nos imports — replique o mesmo conjunto.

- [ ] **Step 6: Register `RankingModule` in `app.module.ts`**

Adicione `RankingModule` ao array `imports` do `AppModule` (mesma forma que `BillingModule`).

- [ ] **Step 7: Run e2e**

Run: `npx jest --config ./jest-integration.json --runInBand test/ranking.e2e-spec.ts`
Expected: PASS (me reflete tier; me por cliente → 403; top ordena e anonimiza).

- [ ] **Step 8: Backend typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/ranking/ src/app.module.ts test/ranking.e2e-spec.ts
git commit -m "feat(ranking): endpoints /ranking/me e /ranking/top"
```

---

### Task 3: Billing usa a taxa do tier como fallback

**Files:**
- Modify: `src/billing/billing.service.ts` (injetar `RankingService`; trocar fallback)
- Modify: `src/billing/billing.module.ts` (importar `RankingModule`)
- Test: novo `test/ranking-billing.e2e-spec.ts` (gift como prova do split por tier — mais simples que montar uma call ACTIVE)

**Interfaces:**
- Consumes: `RankingService.tierRateFor(modelId, tx)` (Task 2).
- Produces: split de `chargeMinute`/`sendGift` usa `resolveTakeRate(profile?.takeRate ?? null, await this.ranking.tierRateFor(modelId, tx))`.

- [ ] **Step 1: Write the failing test**

Prova via `POST /gifts` (caminho `sendGift`, mais simples que montar uma call ACTIVE). Test env tem `GLOBAL_TAKE_RATE=0.40` → BRONZE 0.40, OURO min(0.40,0.20)=0.20. Mesmo preço, a modelo OURO retém mais. Harness igual ao `test/gifts.e2e-spec.ts`.

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Ranking × Billing split', () => {
  let app: INestApplication; let prisma: PrismaService; let ledger: LedgerService; let fakeId: FakeIdentityProvider;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider).compile();
    app = mod.createNestApplication({ rawBody: true }); await app.init();
    prisma = mod.get(PrismaService); ledger = mod.get(LedgerService); fakeId = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => {
    fakeId.reset();
    await prisma.gift.deleteMany(); await prisma.giftType.deleteMany(); await prisma.ledgerEntry.deleteMany();
    await prisma.modelProfile.deleteMany(); await prisma.refreshToken.deleteMany(); await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });
  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fakeId.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function credit(clientId: string, amount: string, ref: string): Promise<void> {
    await ledger.postTransaction(`seed:${ref}`, [
      { account: `client:${clientId}`, entryType: 'RECARGA', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }
  const bal = async (acc: string): Promise<string> => (await ledger.getBalance(acc)).toString();

  it('modelo OURO retém mais que BRONZE no mesmo gift', async () => {
    const oura = await login('mo', 'MODEL');   // vai pra OURO
    const bronze = await login('mb', 'MODEL'); // fica BRONZE (ganho 0 antes do gift)
    // ganho bruto histórico de 2000 pra OURO (conta como histórico, não como a entrada corrente)
    await ledger.postTransaction('seed-earn:mo', [
      { account: `model:${oura.id}`, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('2000') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-2000') },
    ]);
    const gt = await prisma.giftType.create({ data: { name: 'Coroa', priceCredits: new Prisma.Decimal('100.00') } });
    const client = await login('c1', 'CLIENT');
    await credit(client.id, '500.00', 'c1');

    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: oura.id, giftTypeId: gt.id }).expect(201);
    await http().post('/gifts').set('Authorization', `Bearer ${client.token}`).send({ modelId: bronze.id, giftTypeId: gt.id }).expect(201);

    // OURO: ganho corrente = 100 * (1 - 0.20) = 80; o saldo da OURO = 2000 (histórico) + 80
    expect(await bal(`model:${oura.id}`)).toBe('2080');
    // BRONZE: 100 * (1 - 0.40) = 60
    expect(await bal(`model:${bronze.id}`)).toBe('60');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest --config ./jest-integration.json --runInBand test/ranking-billing.e2e-spec.ts`
Expected: FAIL (hoje ambas usam `GLOBAL_TAKE_RATE=0.40`, então a OURO viria com 60, não 80).

- [ ] **Step 3: Inject `RankingService` and switch the fallback**

Em `billing.service.ts`:
- Construtor: adicionar `private readonly ranking: RankingService` (import de `../ranking/ranking.service`).
- Em `chargeMinute`, dentro da `$transaction`, antes do split:
  ```ts
  const tierRate = await this.ranking.tierRateFor(fresh.modelUserId, tx);
  const takeRate = resolveTakeRate(profile?.takeRate ?? null, tierRate);
  ```
- Em `sendGift`, idem com `modelId`:
  ```ts
  const tierRate = await this.ranking.tierRateFor(modelId, tx);
  const takeRate = resolveTakeRate(profile?.takeRate ?? null, tierRate);
  ```
- Remover o uso de `this.globalTakeRate` nesses dois pontos (o campo/validação de env do construtor permanece, pois `loadTierTable`/defaults não substituem o `GLOBAL_TAKE_RATE` exigido no boot; manter a checagem evita mudar contrato de env).

> A `RankingService.grossEarned` aceita `tx` — passe o `tx` da transação corrente pra leitura ser consistente com o lock.

- [ ] **Step 4: Wire the module**

Em `billing.module.ts`: adicionar `RankingModule` ao `imports`. (Sem ciclo: `RankingModule` não importa `BillingModule`.)

- [ ] **Step 5: Run the test**

Run: `npx jest --config ./jest-integration.json --runInBand test/ranking-billing.e2e-spec.ts`
Expected: PASS (OURO 2080, BRONZE 60).

- [ ] **Step 6: Run the existing gifts/billing suites (sem regressão) + typecheck**

Run: `npx jest --config ./jest-integration.json --runInBand test/gifts.e2e-spec.ts test/billing.charge-minute.spec.ts test/take-rate.spec.ts` e `npx tsc --noEmit`
Expected: PASS / sem erros. **Sem regressão garantida:** BRONZE = `GLOBAL_TAKE_RATE` (0.40 no teste), então modelos sem ganho mantêm exatamente o split atual — o `gifts.e2e` ("modelo recebe 6" a 40%) continua válido porque a modelo do teste tem ganho 0 = BRONZE = 0.40. Se algum caso antigo semear ganho > 500 numa modelo cujo split ele assere a 0.40, ajuste reportando.

- [ ] **Step 7: Commit**

```bash
git add src/billing/billing.service.ts src/billing/billing.module.ts test/
git commit -m "feat(billing): takeRate efetiva usa a taxa do tier como fallback"
```

---

### Task 4: Frontend — badge de tier + progresso no painel da modelo

**Files:**
- Modify: `web/src/types/api.ts` (+ `MyRanking`, `RankingEntry`, `Tier`)
- Create: `web/src/ranking/useMyRanking.ts`
- Create: `web/src/ranking/TierBadge.tsx`
- Create: `web/src/ranking/RankingPanel.tsx`
- Modify: `web/src/model/ModelDashboard.tsx` (renderizar `<RankingPanel />`)
- Test: `web/src/ranking/ranking-panel.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` de `../lib/api-client`; tokens Tailwind; `useQuery`.
- Produces:
  - `type Tier = 'BRONZE' | 'PRATA' | 'OURO' | 'DIAMANTE'`
  - `interface MyRanking { tier: Tier; earned: string; takeRate: string; nextTier: Tier | null; nextThreshold: string | null; remaining: string | null }`
  - `interface RankingEntry { rank: number; modelId: string; stageName: string; tier: Tier }`
  - `useMyRanking()` → `useQuery(['ranking-me'], GET /ranking/me)`
  - `<TierBadge tier={Tier} />`, `<RankingPanel />`

- [ ] **Step 1: Add types to `web/src/types/api.ts`**

```ts
export type Tier = 'BRONZE' | 'PRATA' | 'OURO' | 'DIAMANTE';

export interface MyRanking {
  tier: Tier;
  earned: string;
  takeRate: string;
  nextTier: Tier | null;
  nextThreshold: string | null;
  remaining: string | null;
}

export interface RankingEntry {
  rank: number;
  modelId: string;
  stageName: string;
  tier: Tier;
}
```

- [ ] **Step 2: Write the failing test**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RankingPanel } from './RankingPanel';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'm1', role: 'MODEL', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function renderPanel(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, body)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><RankingPanel /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('RankingPanel', () => {
  it('mostra o tier e quanto falta pro próximo', async () => {
    renderPanel({ tier: 'PRATA', earned: '800.00', takeRate: '0.25', nextTier: 'OURO', nextThreshold: '2000.00', remaining: '1200.00' });
    await waitFor(() => expect(screen.getByText('PRATA')).toBeInTheDocument());
    expect(screen.getByText(/1200\.00/)).toBeInTheDocument();
    expect(screen.getByText(/OURO/)).toBeInTheDocument();
  });

  it('tier máximo não mostra progresso', async () => {
    renderPanel({ tier: 'DIAMANTE', earned: '12000.00', takeRate: '0.15', nextTier: null, nextThreshold: null, remaining: null });
    await waitFor(() => expect(screen.getByText('DIAMANTE')).toBeInTheDocument());
    expect(screen.getByText(/tier máximo/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/ranking/ranking-panel.test.tsx`
Expected: FAIL (RankingPanel não existe).

- [ ] **Step 4: Implement `useMyRanking.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { MyRanking } from '../types/api';

export function useMyRanking(): ReturnType<typeof useQuery<MyRanking>> {
  return useQuery<MyRanking>({
    queryKey: ['ranking-me'],
    queryFn: () => apiFetch<MyRanking>('/ranking/me', { auth: true }),
  });
}
```

- [ ] **Step 5: Implement `TierBadge.tsx`**

```tsx
import type { Tier } from '../types/api';

const STYLE: Record<Tier, string> = {
  BRONZE: 'bg-velvet text-gold',
  PRATA: 'bg-velvet text-mist',
  OURO: 'bg-gold/20 text-gold',
  DIAMANTE: 'bg-ember/20 text-ember',
};

export function TierBadge({ tier }: { tier: Tier }): JSX.Element {
  return (
    <span className={`inline-block rounded-full px-3 py-1 font-mono text-xs uppercase tracking-wide ${STYLE[tier]}`}>
      {tier}
    </span>
  );
}
```

- [ ] **Step 6: Implement `RankingPanel.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { useMyRanking } from './useMyRanking';
import { TierBadge } from './TierBadge';

export function RankingPanel(): JSX.Element {
  const { data } = useMyRanking();
  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <div className="flex items-center justify-between">
        <p className="text-mist text-sm">Seu ranking</p>
        <Link to="/ranking" className="text-mist text-sm underline hover:text-cream">ver ranking</Link>
      </div>
      {data ? (
        <div className="mt-3">
          <TierBadge tier={data.tier} />
          <p className="mt-3 font-mono text-sm text-mist">comissão atual: {(Number(data.takeRate) * 100).toFixed(0)}%</p>
          {data.nextTier ? (
            <p className="mt-1 text-cream text-sm">faltam <span className="font-mono text-gold">⌗ {data.remaining}</span> pra {data.nextTier}</p>
          ) : (
            <p className="mt-1 text-gold text-sm">tier máximo 💎</p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-mist text-sm">…</p>
      )}
    </section>
  );
}
```

- [ ] **Step 7: Render in `ModelDashboard.tsx`**

Importar `RankingPanel` e renderizar logo após `<PresenceToggle />` (antes de `<ProfileForm />`):
```tsx
import { RankingPanel } from '../ranking/RankingPanel';
// ...
<div className="mt-8"><PresenceToggle /></div>
<RankingPanel />
<ProfileForm />
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd web && npx vitest run src/ranking/ranking-panel.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 9: Front build**

Run: `cd web && npm run build`
Expected: sem erros de tipo.

- [ ] **Step 10: Commit**

```bash
git add web/src/types/api.ts web/src/ranking/useMyRanking.ts web/src/ranking/TierBadge.tsx web/src/ranking/RankingPanel.tsx web/src/model/ModelDashboard.tsx web/src/ranking/ranking-panel.test.tsx
git commit -m "feat(web): painel de ranking/tier da modelo com progresso"
```

---

### Task 5: Frontend — leaderboard público `/ranking`

**Files:**
- Create: `web/src/ranking/useRankingTop.ts`
- Create: `web/src/ranking/RankingPage.tsx`
- Modify: `web/src/App.tsx` (rota `/ranking`)
- Modify: `web/src/discovery/DiscoveryPage.tsx` (link "Ranking" no header — confirme o local do header de navegação)
- Test: `web/src/ranking/ranking-page.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`; `RankingEntry` (Task 4); `TierBadge` (Task 4); `useQuery`; `Link`.
- Produces: `useRankingTop()` → `useQuery(['ranking-top'], GET /ranking/top)`; `<RankingPage />` na rota `/ranking`.

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RankingPage } from './RankingPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function renderPage(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, body)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter><RankingPage /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('RankingPage', () => {
  it('lista o top com posição, tier e stageName', async () => {
    renderPage([
      { rank: 1, modelId: 'a', stageName: 'Lara', tier: 'OURO' },
      { rank: 2, modelId: 'b', stageName: 'Bianca', tier: 'PRATA' },
    ]);
    await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
    expect(screen.getByText('Bianca')).toBeInTheDocument();
    expect(screen.getByText('OURO')).toBeInTheDocument();
  });

  it('lista vazia mostra estado vazio', async () => {
    renderPage([]);
    await waitFor(() => expect(screen.getByText(/ranking ainda vazio/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/ranking/ranking-page.test.tsx`
Expected: FAIL (RankingPage não existe).

- [ ] **Step 3: Implement `useRankingTop.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { RankingEntry } from '../types/api';

export function useRankingTop(): ReturnType<typeof useQuery<RankingEntry[]>> {
  return useQuery<RankingEntry[]>({
    queryKey: ['ranking-top'],
    queryFn: () => apiFetch<RankingEntry[]>('/ranking/top', { auth: true }),
  });
}
```

- [ ] **Step 4: Implement `RankingPage.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { useRankingTop } from './useRankingTop';
import { TierBadge } from './TierBadge';

export function RankingPage(): JSX.Element {
  const { data } = useRankingTop();
  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Ranking</h1>
        <Link to="/" className="text-mist text-sm hover:text-cream">descoberta</Link>
      </header>
      {data && data.length > 0 ? (
        <ol className="mt-8 flex flex-col gap-2">
          {data.map((e) => (
            <li key={e.modelId}>
              <Link to={`/models/${e.modelId}`} className="flex items-center justify-between rounded-xl bg-velvet px-4 py-3 hover:ring-1 hover:ring-ember">
                <span className="flex items-center gap-3">
                  <span className="font-mono text-mist">#{e.rank}</span>
                  <span className="text-cream">{e.stageName}</span>
                </span>
                <TierBadge tier={e.tier} />
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-8 text-mist">Ranking ainda vazio.</p>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Add route in `App.tsx`**

```tsx
import { RankingPage } from './ranking/RankingPage';
// dentro de <Routes>:
<Route path="/ranking" element={<ProtectedRoute><RankingPage /></ProtectedRoute>} />
```

- [ ] **Step 6: Add nav link in the discovery header**

Em `web/src/discovery/DiscoveryPage.tsx`, no header onde já existe o link da Carteira/saldo, adicionar um `<Link to="/ranking" className="text-mist text-sm hover:text-cream">Ranking</Link>`. (Confira o markup exato do header e siga o padrão dos links existentes.)

- [ ] **Step 7: Run test to verify it passes**

Run: `cd web && npx vitest run src/ranking/ranking-page.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 8: Run whole front suite + build**

Run: `cd web && npx vitest run && npm run build`
Expected: tudo verde; build sem erros.

- [ ] **Step 9: Commit**

```bash
git add web/src/ranking/useRankingTop.ts web/src/ranking/RankingPage.tsx web/src/App.tsx web/src/discovery/DiscoveryPage.tsx web/src/ranking/ranking-page.test.tsx
git commit -m "feat(web): página de ranking (leaderboard) com tiers"
```

---

## Notas de verificação final (whole-branch)
- Backend: `npx tsc --noEmit` limpo; suites de ranking + billing verdes.
- Front: `npm run build` limpo; suite verde.
- Conferir anonimato no `/ranking/top` (sem `displayName`/`earned`).
- Conferir que modelos sem ganho ficam BRONZE e que o split default não regrediu.
