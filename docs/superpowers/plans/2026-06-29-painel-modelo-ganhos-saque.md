# Painel da Modelo #2 (Ganhos & Saque) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A modelo vê ganhos e solicita saque PIX (com histórico); atalho dev credita ganhos + aprova KYC pra demonstrar.

**Architecture:** Expor o `requestPayout` existente via `POST /payouts`, listar via `GET /payouts`, e ler ganhos via `GET /wallet/earnings` (saldo em `model:<id>`). Front: seção Ganhos no `/painel`. Nada da lógica financeira muda — só expõe.

**Tech Stack:** NestJS/Prisma, Jest e2e; React/Vite, TanStack Query, Vitest.

## Global Constraints

- `GET /wallet/earnings` (`@Roles('MODEL')`) → `{ balance: string }` de `getBalance('model:<req.user.id>')`.
- `POST /payouts` (`@Roles('MODEL')`) `{amount, pixKey}` → `requestPayout('model:<id>', new Prisma.Decimal(amount), pixKey)`; exceções sobem: **KYC não aprovado → 403**, abaixo do mínimo/sem saldo → **400**.
- `GET /payouts` (`@Roles('MODEL')`) → saques do próprio modelo, mais recentes primeiro.
- `POST /payouts/dev-grant` só com `DEV_LOGIN==='true'` E `NODE_ENV!=='production'` (senão 404); credita ganhos em `model:<id>` + marca KYC aprovado pra ele.
- Não alterar `requestPayout`. `import type` em interfaces. Backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo. Front testa com boundary mockado.

---

## File Structure

```
src/wallet/wallet-balance.controller.ts   + @Get('earnings') @Roles('MODEL')        [mod]
src/payout/payout.service.ts              + listForAccount + grantDevEarnings        [mod]
src/payout/payout.controller.ts           POST / + GET / + POST dev-grant            [novo]
src/payout/payout.module.ts               + controller + Auth/Users/Prisma           [mod]
test/wallet.earnings.e2e-spec.ts                                                     [novo]
test/payout.api.e2e-spec.ts                                                         [novo]
web/src/types/api.ts                      + Payout                                   [mod]
web/src/model/useEarnings.ts / usePayouts.ts / useRequestPayout.ts                  [novo]
web/src/model/EarningsPanel.tsx                                                     [novo]
web/src/model/ModelDashboard.tsx          + <EarningsPanel/>                         [mod]
web/src/model/earnings.test.tsx                                                     [novo]
```

Backend e2e: `npx jest --config ./jest-integration.json --runInBand <file>`. Front: `cd web && npx vitest run <file>`.

---

## Task 1: Backend — `GET /wallet/earnings`

**Files:**
- Modify: `src/wallet/wallet-balance.controller.ts`
- Test: `test/wallet.earnings.e2e-spec.ts`

**Interfaces:**
- Produces: `GET /wallet/earnings` (MODEL) → `{ balance: string }` de `model:<id>`.

- [ ] **Step 1: Escrever o e2e que falha**

Create `test/wallet.earnings.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /wallet/earnings', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => { await prisma.ledgerEntry.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });

  async function model(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'MODEL' }) };
  }

  it('retorna o saldo de ganhos da modelo (model:<id>)', async () => {
    const m = await model();
    await ledger.postTransaction(`seed:${m.id}`, [
      { account: `model:${m.id}`, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('120.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-120.00') },
    ]);
    const res = await request(app.getHttpServer()).get('/wallet/earnings').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.balance).toBe('120');
  });

  it('CLIENT não acessa earnings (403)', async () => {
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    const token = tokens.signAccess({ id: u.id, role: 'CLIENT' });
    await request(app.getHttpServer()).get('/wallet/earnings').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.earnings.e2e-spec.ts`
Expected: FAIL — rota inexistente (404).

- [ ] **Step 3: Adicionar o método ao controller**

In `src/wallet/wallet-balance.controller.ts`, add the import for `Roles` is already there (used by `balance`). Add a method to the class:
```ts
  @Get('earnings')
  @Roles('MODEL')
  async earnings(@Req() req: Request & { user: AuthUser }): Promise<{ balance: string }> {
    const b = await this.ledger.getBalance(`model:${req.user.id}`);
    return { balance: b.toString() };
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.earnings.e2e-spec.ts`
Expected: PASS (2/2).

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/wallet/wallet-balance.controller.ts test/wallet.earnings.e2e-spec.ts
git commit -m "feat(wallet): GET /wallet/earnings (ganhos da modelo)"
```

---

## Task 2: Backend — PayoutController (request + list + dev-grant)

**Files:**
- Modify: `src/payout/payout.service.ts`, `src/payout/payout.module.ts`
- Create: `src/payout/payout.controller.ts`
- Test: `test/payout.api.e2e-spec.ts`

**Interfaces:**
- Consumes: `PayoutService.requestPayout(account, amount, pixKey)`; `LedgerService`, `PrismaService`, `KYC` (na service).
- Produces: `PayoutService.listForAccount(account): Promise<Payout[]>`, `PayoutService.grantDevEarnings(account): Promise<void>`; `POST /payouts`, `GET /payouts`, `POST /payouts/dev-grant`.

- [ ] **Step 1: Escrever o e2e que falha**

Create `test/payout.api.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('Payout API', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LedgerService;
  let tokens: TokenService;
  const prev = process.env.DEV_LOGIN;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    ledger = mod.get(LedgerService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.payout.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN; else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  async function model(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'MODEL' }) };
  }
  async function fund(account: string, amount: string): Promise<void> {
    await ledger.postTransaction(`seed:${account}:${amount}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal(amount) },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal(amount).negated() },
    ]);
  }

  it('com KYC aprovado e saldo, POST /payouts cria PENDING e debita', async () => {
    const m = await model();
    await prisma.kycStatus.create({ data: { account: `model:${m.id}`, approved: true } });
    await fund(`model:${m.id}`, '300.00');
    const res = await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '300.00', pixKey: 'chave@x.com' }).expect(201);
    expect(res.body.status).toBe('PENDING');
    expect((await ledger.getBalance(`model:${m.id}`)).toString()).toBe('0');
  });

  it('sem KYC aprovado → 403', async () => {
    const m = await model();
    await fund(`model:${m.id}`, '300.00');
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '300.00', pixKey: 'k' }).expect(403);
  });

  it('abaixo do mínimo → 400', async () => {
    const m = await model();
    await prisma.kycStatus.create({ data: { account: `model:${m.id}`, approved: true } });
    await fund(`model:${m.id}`, '300.00');
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '50.00', pixKey: 'k' }).expect(400);
  });

  it('GET /payouts lista os saques da modelo', async () => {
    const m = await model();
    await prisma.kycStatus.create({ data: { account: `model:${m.id}`, approved: true } });
    await fund(`model:${m.id}`, '300.00');
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '300.00', pixKey: 'k' }).expect(201);
    const res = await request(app.getHttpServer()).get('/payouts').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].pixKey).toBe('k');
  });

  it('dev-grant (DEV_LOGIN=true) credita ganhos e aprova KYC; depois o saque passa', async () => {
    process.env.DEV_LOGIN = 'true';
    const m = await model();
    await request(app.getHttpServer()).post('/payouts/dev-grant').set('Authorization', `Bearer ${m.token}`).expect(201);
    expect((await ledger.getBalance(`model:${m.id}`)).greaterThan(new Prisma.Decimal('200'))).toBe(true);
    await request(app.getHttpServer()).post('/payouts').set('Authorization', `Bearer ${m.token}`).send({ amount: '200.00', pixKey: 'k' }).expect(201);
  });

  it('dev-grant desligado → 404', async () => {
    delete process.env.DEV_LOGIN;
    const m = await model();
    await request(app.getHttpServer()).post('/payouts/dev-grant').set('Authorization', `Bearer ${m.token}`).expect(404);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.api.e2e-spec.ts`
Expected: FAIL — rotas inexistentes.

- [ ] **Step 3: Helpers na PayoutService**

In `src/payout/payout.service.ts`, add these two methods to the class (the constructor already injects `prisma`, `ledger`):
```ts
  async listForAccount(account: string): Promise<import('@prisma/client').Payout[]> {
    return this.prisma.payout.findMany({ where: { account }, orderBy: { createdAt: 'desc' } });
  }

  async grantDevEarnings(account: string): Promise<void> {
    await this.ledger.postTransaction(`dev-earn:${account}:${Date.now()}`, [
      { account, entryType: 'GANHO_MIN', amount: new Prisma.Decimal('300.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-300.00') },
    ]);
    await this.prisma.kycStatus.upsert({ where: { account }, update: { approved: true }, create: { account, approved: true } });
  }
```

- [ ] **Step 4: Criar o PayoutController**

Create `src/payout/payout.controller.ts`:
```ts
import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PayoutService } from './payout.service';

interface RequestPayoutDto {
  amount: string;
  pixKey: string;
}

@Controller('payouts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MODEL')
export class PayoutController {
  constructor(private readonly payouts: PayoutService) {}

  @Post()
  async request(@Req() req: Request & { user: AuthUser }, @Body() dto: RequestPayoutDto): Promise<unknown> {
    if (!dto?.pixKey || typeof dto.pixKey !== 'string') {
      throw new BadRequestException('pixKey is required');
    }
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(dto.amount);
    } catch {
      throw new BadRequestException('amount must be a valid decimal');
    }
    return this.payouts.requestPayout(`model:${req.user.id}`, amount, dto.pixKey);
  }

  @Get()
  async list(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    return this.payouts.listForAccount(`model:${req.user.id}`);
  }

  @Post('dev-grant')
  async devGrant(@Req() req: Request & { user: AuthUser }): Promise<{ ok: true }> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    await this.payouts.grantDevEarnings(`model:${req.user.id}`);
    return { ok: true };
  }
}
```

- [ ] **Step 5: Religar o PayoutModule**

Replace the entire contents of `src/payout/payout.module.ts` with:
```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { KycModule } from '../kyc/kyc.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { PayoutService } from './payout.service';
import { PayoutProcessor } from './payout.processor';
import { PayoutController } from './payout.controller';
import { PSP_PAYOUT_PORT } from './psp-payout.port';
import { RealPspPayoutPort } from './real-psp-payout.adapter';

@Module({
  imports: [PrismaModule, LedgerModule, KycModule, AuthModule, UsersModule],
  controllers: [PayoutController],
  providers: [
    PayoutService,
    PayoutProcessor,
    { provide: PSP_PAYOUT_PORT, useClass: RealPspPayoutPort },
  ],
  exports: [PayoutService, PayoutProcessor],
})
export class PayoutModule {}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/payout.api.e2e-spec.ts`
Expected: PASS (6/6).

- [ ] **Step 7: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/payout/payout.service.ts src/payout/payout.controller.ts src/payout/payout.module.ts test/payout.api.e2e-spec.ts
git commit -m "feat(payout): API de saque da modelo (POST/GET /payouts + dev-grant)"
```

---

## Task 3: Frontend — seção Ganhos no /painel

**Files:**
- Modify: `web/src/types/api.ts`, `web/src/model/ModelDashboard.tsx`
- Create: `web/src/model/useEarnings.ts`, `usePayouts.ts`, `useRequestPayout.ts`, `EarningsPanel.tsx`, `earnings.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`. Produces: `<EarningsPanel/>`; hooks; tipo `Payout`.

- [ ] **Step 1: Tipo Payout**

In `web/src/types/api.ts`, add:
```ts
export interface Payout {
  id: string;
  amount: string;
  status: string;
  pixKey: string;
  createdAt: string;
  processedAt?: string | null;
}
```

- [ ] **Step 2: Escrever os testes (falham)**

Create `web/src/model/earnings.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EarningsPanel } from './EarningsPanel';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'MODEL', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('EarningsPanel', () => {
  it('mostra os ganhos e o histórico', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '250' }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, [{ id: 'p1', amount: '200.00', status: 'PENDING', pixKey: 'k', createdAt: '2026-06-29' }]));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<EarningsPanel />));
    await waitFor(() => expect(screen.getByText(/250/)).toBeInTheDocument());
    expect(screen.getByText(/PENDING/i)).toBeInTheDocument();
  });

  it('solicitar saque chama POST /payouts', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '250' }));
      if (u.endsWith('/payouts') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'p1', amount: '200.00', status: 'PENDING', pixKey: 'k', createdAt: 'x' }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, []));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<EarningsPanel />));
    await screen.findByText(/250/);
    await userEvent.clear(screen.getByLabelText(/valor/i));
    await userEvent.type(screen.getByLabelText(/valor/i), '200');
    await userEvent.type(screen.getByLabelText(/chave pix/i), 'k');
    await userEvent.click(screen.getByRole('button', { name: /solicitar saque/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/payouts') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ amount: '200', pixKey: 'k' });
    });
  });

  it('erro 403 no saque mostra aviso de KYC', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '250' }));
      if (u.endsWith('/payouts') && init?.method === 'POST') return Promise.resolve(json(403, { message: 'KYC not approved' }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, []));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<EarningsPanel />));
    await screen.findByText(/250/);
    await userEvent.type(screen.getByLabelText(/valor/i), '200');
    await userEvent.type(screen.getByLabelText(/chave pix/i), 'k');
    await userEvent.click(screen.getByRole('button', { name: /solicitar saque/i }));
    await waitFor(() => expect(screen.getByText(/kyc/i)).toBeInTheDocument());
  });

  it('botão dev aparece com VITE_DEV_LOGIN e chama dev-grant', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/earnings')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/payouts/dev-grant')) return Promise.resolve(json(201, { ok: true }));
      if (u.endsWith('/payouts')) return Promise.resolve(json(200, []));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<EarningsPanel />));
    await screen.findByText(/0/);
    await userEvent.click(screen.getByRole('button', { name: /creditar ganhos/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/payouts/dev-grant'))).toBe(true));
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/model/earnings.test.tsx`
Expected: FAIL — `EarningsPanel` não existe.

- [ ] **Step 4: Hooks**

Create `web/src/model/useEarnings.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useEarnings(): ReturnType<typeof useQuery<{ balance: string }>> {
  return useQuery<{ balance: string }>({
    queryKey: ['earnings'],
    queryFn: () => apiFetch<{ balance: string }>('/wallet/earnings', { auth: true }),
  });
}
```

Create `web/src/model/usePayouts.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Payout } from '../types/api';

export function usePayouts(): ReturnType<typeof useQuery<Payout[]>> {
  return useQuery<Payout[]>({
    queryKey: ['payouts'],
    queryFn: () => apiFetch<Payout[]>('/payouts', { auth: true }),
  });
}
```

Create `web/src/model/useRequestPayout.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Payout } from '../types/api';

export function useRequestPayout(): ReturnType<typeof useMutation<Payout, Error, { amount: string; pixKey: string }>> {
  const qc = useQueryClient();
  return useMutation<Payout, Error, { amount: string; pixKey: string }>({
    mutationFn: (dto) => apiFetch<Payout>('/payouts', { method: 'POST', body: dto, auth: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
      void qc.invalidateQueries({ queryKey: ['earnings'] });
    },
  });
}

export function useDevGrant(): ReturnType<typeof useMutation<unknown, Error, void>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationFn: () => apiFetch('/payouts/dev-grant', { method: 'POST', auth: true }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payouts'] });
      void qc.invalidateQueries({ queryKey: ['earnings'] });
    },
  });
}
```

- [ ] **Step 5: EarningsPanel**

Create `web/src/model/EarningsPanel.tsx`:
```tsx
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../lib/api-client';
import { useEarnings } from './useEarnings';
import { usePayouts } from './usePayouts';
import { useRequestPayout, useDevGrant } from './useRequestPayout';

export function EarningsPanel(): JSX.Element {
  const { data: earnings } = useEarnings();
  const { data: payouts } = usePayouts();
  const requestPayout = useRequestPayout();
  const devGrant = useDevGrant();
  const [amount, setAmount] = useState('200');
  const [pixKey, setPixKey] = useState('');
  const devEnabled = import.meta.env.VITE_DEV_LOGIN === 'true';

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    requestPayout.mutate({ amount, pixKey });
  };

  const errorMsg = (): string | null => {
    const err = requestPayout.error;
    if (!err) return null;
    if (err instanceof ApiError && err.status === 403) return 'Saque requer KYC aprovado.';
    if (err instanceof ApiError && err.status === 400) return 'Valor abaixo do mínimo ou saldo insuficiente.';
    return 'Não foi possível solicitar o saque.';
  };

  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <p className="text-mist text-sm">Ganhos</p>
      <p className="mt-1 font-mono text-3xl text-cream">⌗ {earnings?.balance ?? '…'} <span className="text-base text-mist">créditos</span></p>

      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <div>
          <label htmlFor="payout-amount" className="block text-mist text-sm">Valor do saque</label>
          <input id="payout-amount" type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full rounded-lg bg-void px-4 py-3 font-mono text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
        </div>
        <div>
          <label htmlFor="payout-pix" className="block text-mist text-sm">Chave PIX</label>
          <input id="payout-pix" value={pixKey} onChange={(e) => setPixKey(e.target.value)} className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
        </div>
        <button type="submit" disabled={requestPayout.isPending} className="rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50">
          {requestPayout.isPending ? 'Solicitando…' : 'Solicitar saque'}
        </button>
        {errorMsg() && <p className="text-ember text-sm">{errorMsg()}</p>}
        {requestPayout.isSuccess && <p className="text-gold text-sm">Saque solicitado ✓</p>}
      </form>

      {devEnabled && (
        <button onClick={() => devGrant.mutate()} className="mt-4 rounded-full border border-mist/40 px-5 py-2 text-cream text-sm hover:border-ember">
          Creditar ganhos de teste (dev)
        </button>
      )}

      <div className="mt-8">
        <p className="text-mist text-sm">Histórico de saques</p>
        {payouts && payouts.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-2">
            {payouts.map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded-lg bg-void px-4 py-3">
                <span className="font-mono text-cream">⌗ {p.amount}</span>
                <span className="text-xs uppercase tracking-wide text-gold">{p.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-mist text-sm">Nenhum saque ainda.</p>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 6: Wire no ModelDashboard**

In `web/src/model/ModelDashboard.tsx`, import and render `<EarningsPanel />` after `<ProfileForm />`:
```tsx
import { EarningsPanel } from './EarningsPanel';
```
and in the JSX, after `<ProfileForm />`:
```tsx
      <EarningsPanel />
```

- [ ] **Step 7: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/model/earnings.test.tsx`
Expected: PASS (4/4). Depois `npx vitest run` (suíte inteira) verde.

- [ ] **Step 8: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/types/api.ts web/src/model
git commit -m "feat(web): painel — ganhos + solicitar saque + histórico"
```

---

## Task 4: Verificação final + push

- [ ] **Step 1:** `npm run test:int` → verde.
- [ ] **Step 2:** (in `web/`) `npx vitest run` e `npm run build` → verdes.
- [ ] **Step 3 (manual):** `/painel` como modelo → "Creditar ganhos de teste" → ganhos sobem → solicitar saque (≥200 + chave) → aparece no histórico.
- [ ] **Step 4:** `git push origin main`.

---

## Self-Review (autor)

**Cobertura do spec:** §4.1 earnings → T1; listForAccount/grantDevEarnings/PayoutController(request/list/dev-grant)+module → T2; §4.2 hooks+EarningsPanel+wire → T3; §6 testes (earnings/403/400/list/dev-grant; front ganhos/saque/403/dev) → T1/T2/T3; §7 manual → T4.

**Consistência de tipos:** `requestPayout('model:'+id, Decimal, pixKey)` reusado; `Payout {id,amount,status,pixKey,createdAt,processedAt?}` casa back/front; rotas `/wallet/earnings`, `/payouts`, `/payouts/dev-grant` idênticas; `ApiError.status` 403/400 mapeado no front.

**Placeholders:** nenhum — código/comando concreto. Gate de tipos do front = `npm run build`.
