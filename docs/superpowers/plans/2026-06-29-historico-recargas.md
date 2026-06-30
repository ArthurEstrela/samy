# Histórico de recargas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cliente vê o histórico das próprias recargas PIX na Carteira.

**Architecture:** Um endpoint de listagem `GET /wallet/recharge/history` (CLIENT) declarado antes da rota param `:id`, e uma lista no front consumindo-o.

**Tech Stack:** NestJS + Prisma (back); Vite + React 18 + TanStack Query v5 + Vitest (front).

## Global Constraints
- `@Get('history')` deve ser declarado **antes** de `@Get(':id')` no `recharge.controller.ts` (senão "history" vira `id`).
- Só recargas do `req.user.id`. Resposta `{ id, amount: string, status, createdAt, paidAt }` — sem `pspChargeId`/`qrText`.
- `import type` em imports de tipo. Backend gate: `npx tsc --noEmit`. Front gate: `npm run build` (tsc -b strict). e2e via `jest-integration.json` (Postgres de teste no ar). Front com `fetch` mockado + `setSession`.

---

### Task 1: Endpoint `GET /wallet/recharge/history`

**Files:**
- Modify: `src/wallet/recharge.controller.ts` (adicionar `@Get('history')` ANTES do `@Get(':id')`)
- Test: `test/wallet.recharge-history.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (já injetado no controller), `Roles('CLIENT')`, `JwtAuthGuard`/`RolesGuard`.
- Produces: `GET /wallet/recharge/history` → `{ id: string; amount: string; status: string; createdAt: Date; paidAt: Date | null }[]`.

- [ ] **Step 1: Write the failing e2e test**

Harness no estilo `test/wallet.balance.e2e-spec.ts` (TokenService.signAccess + criação direta via prisma). Semear recargas com `prisma.recharge.create`.

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /wallet/recharge/history', () => {
  let app: INestApplication; let prisma: PrismaService; let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService); tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.recharge.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function user(role: string): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { role, provider: 'google', providerSubject: `s-${Math.random()}`, email: 'x@y.com', displayName: 'X', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role }) };
  }
  async function recharge(userId: string, amount: string, status: string, pspChargeId: string): Promise<void> {
    await prisma.recharge.create({ data: { userId, amount: new Prisma.Decimal(amount), status, pspChargeId, qrText: 'qr-secret' } });
  }
  function http() { return request(app.getHttpServer()); }

  it('lista só as recargas do próprio cliente, desc, sem vazar qrText/pspChargeId', async () => {
    const a = await user('CLIENT');
    const b = await user('CLIENT');
    await recharge(a.id, '20.00', 'PAID', 'psp-a1');
    await new Promise((r) => setTimeout(r, 5));
    await recharge(a.id, '50.00', 'PENDING', 'psp-a2');
    await recharge(b.id, '99.00', 'PAID', 'psp-b1');

    const res = await http().get('/wallet/recharge/history').set('Authorization', `Bearer ${a.token}`).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].amount).toBe('50'); // mais recente primeiro
    expect(res.body[1].amount).toBe('20');
    expect(res.body[0]).toHaveProperty('status', 'PENDING');
    expect(res.body[0]).toHaveProperty('createdAt');
    expect(res.body[0]).not.toHaveProperty('qrText');
    expect(res.body[0]).not.toHaveProperty('pspChargeId');
  });

  it('MODEL → 403', async () => {
    const m = await user('MODEL');
    await http().get('/wallet/recharge/history').set('Authorization', `Bearer ${m.token}`).expect(403);
  });

  it('sem token → 401', async () => {
    await http().get('/wallet/recharge/history').expect(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

> e2e via integração (Postgres de teste já no ar): se necessário `docker compose up -d` + `npm run db:test:push`.

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge-history.e2e-spec.ts`
Expected: FAIL — sem a rota, `history` cai no `@Get(':id')` → 404 (não 200/403 esperados).

- [ ] **Step 3: Implement the endpoint**

Em `src/wallet/recharge.controller.ts`, adicionar o método **imediatamente antes** do `@Get(':id')` existente:

```ts
  @Get('history')
  @Roles('CLIENT')
  async history(@Req() req: Request & { user: AuthUser }): Promise<unknown> {
    const rows = await this.prisma.recharge.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      amount: r.amount.toString(),
      status: r.status,
      createdAt: r.createdAt,
      paidAt: r.paidAt,
    }));
  }
```

(`Get`, `Roles`, `Req`, `AuthUser` já estão importados no arquivo.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.recharge-history.e2e-spec.ts`
Expected: PASS (3/3 — lista própria desc sem vazar; MODEL 403; sem token 401).

- [ ] **Step 5: Garantir que `@Get(':id')` ainda funciona**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.dev-confirm.e2e-spec.ts test/wallet.recharge.spec.ts`
Expected: PASS (a rota `:id` e o fluxo de recarga não regrediram). Se algum desses arquivos não existir/usar `:id`, rode `test/` de wallet equivalente.

- [ ] **Step 6: Backend typecheck**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add src/wallet/recharge.controller.ts test/wallet.recharge-history.e2e-spec.ts
git commit -m "feat(wallet): GET /wallet/recharge/history (recargas do cliente)"
```

---

### Task 2: Frontend — lista de recargas na Carteira

**Files:**
- Modify: `web/src/types/api.ts` (+ `RechargeSummary`)
- Create: `web/src/wallet/useRecharges.ts`
- Create: `web/src/wallet/RechargeHistory.tsx`
- Modify: `web/src/wallet/WalletPage.tsx` (+ `<RechargeHistory />`)
- Test: `web/src/wallet/recharge-history.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` de `../lib/api-client`; `useQuery`; tokens Tailwind; `setSession` (nos testes).
- Produces: `useRecharges()` → `useQuery(['recharges'], GET /wallet/recharge/history)`; `<RechargeHistory />`.

- [ ] **Step 1: Add type to `web/src/types/api.ts`**

```ts
export interface RechargeSummary {
  id: string;
  amount: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
}
```

- [ ] **Step 2: Write the failing test**

Boilerplate igual ao `web/src/gifts/gifts.test.tsx` (vitest imports, `setSession`, `json()`).

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RechargeHistory } from './RechargeHistory';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function renderHistory(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => json(200, body)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><RechargeHistory /></QueryClientProvider>);
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('RechargeHistory', () => {
  it('lista as recargas com valor e status', async () => {
    renderHistory([
      { id: 'r1', amount: '50.00', status: 'PENDING', createdAt: '2026-06-29T10:00:00.000Z', paidAt: null },
      { id: 'r2', amount: '20.00', status: 'PAID', createdAt: '2026-06-28T10:00:00.000Z', paidAt: '2026-06-28T10:01:00.000Z' },
    ]);
    await waitFor(() => expect(screen.getByText(/50\.00/)).toBeInTheDocument());
    expect(screen.getByText(/20\.00/)).toBeInTheDocument();
    expect(screen.getByText(/paga/i)).toBeInTheDocument();
    expect(screen.getByText(/pendente/i)).toBeInTheDocument();
  });

  it('estado vazio', async () => {
    renderHistory([]);
    await waitFor(() => expect(screen.getByText(/nenhuma recarga ainda/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/wallet/recharge-history.test.tsx`
Expected: FAIL (RechargeHistory não existe).

- [ ] **Step 4: Implement `useRecharges.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { RechargeSummary } from '../types/api';

export function useRecharges(): ReturnType<typeof useQuery<RechargeSummary[]>> {
  return useQuery<RechargeSummary[]>({
    queryKey: ['recharges'],
    queryFn: () => apiFetch<RechargeSummary[]>('/wallet/recharge/history', { auth: true }),
  });
}
```

- [ ] **Step 5: Implement `RechargeHistory.tsx`**

```tsx
import { useRecharges } from './useRecharges';
import type { RechargeSummary } from '../types/api';

const LABEL: Record<string, { text: string; cls: string }> = {
  PAID: { text: 'paga', cls: 'text-gold' },
  PENDING: { text: 'pendente', cls: 'text-mist' },
  EXPIRED: { text: 'expirada', cls: 'text-mist' },
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function RechargeHistory(): JSX.Element {
  const { data } = useRecharges();
  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <p className="text-mist text-sm">Recargas</p>
      {data && data.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-2">
          {data.map((r: RechargeSummary) => {
            const label = LABEL[r.status] ?? { text: r.status, cls: 'text-mist' };
            return (
              <li key={r.id} className="flex items-center justify-between rounded-xl bg-void px-4 py-3">
                <span className="font-mono text-cream">⌗ {r.amount}</span>
                <span className="flex items-center gap-3">
                  <span className={`text-sm ${label.cls}`}>{label.text}</span>
                  <span className="font-mono text-xs text-mist">{fmtDate(r.createdAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-mist text-sm">Nenhuma recarga ainda.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Render in `WalletPage.tsx`**

Importar e renderizar após `<RechargePanel />`:
```tsx
import { RechargeHistory } from './RechargeHistory';
// ...
      <RechargePanel />
      <RechargeHistory />
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd web && npx vitest run src/wallet/recharge-history.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 8: Whole front suite + build**

Run: `cd web && npx vitest run && npm run build`
Expected: tudo verde; build sem erros.

- [ ] **Step 9: Commit**

```bash
git add web/src/types/api.ts web/src/wallet/useRecharges.ts web/src/wallet/RechargeHistory.tsx web/src/wallet/WalletPage.tsx web/src/wallet/recharge-history.test.tsx
git commit -m "feat(web): histórico de recargas na Carteira"
```

---

## Notas de verificação final
- `npx tsc --noEmit` limpo; e2e de recarga (history + `:id`/dev-confirm) verdes.
- Front `npm run build` limpo; suite verde.
- Conferir que `history` não vaza `qrText`/`pspChargeId` e que `:id` continua funcionando.
