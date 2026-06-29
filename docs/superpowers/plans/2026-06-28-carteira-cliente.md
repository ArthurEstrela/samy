# Carteira / Recarga do Cliente Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cliente vê saldo e recarrega via PIX (QR + polling até PAID); em dev, um botão simula a confirmação.

**Architecture:** Backend ganha `GET /wallet/balance` (CLIENT) e `POST /wallet/recharge/:id/dev-confirm` (dev-only, dupla-trava). Front ganha `/wallet` (saldo + criar recarga + QR via qrcode.react + polling) e saldo+link no header da descoberta. Reusa `confirmRecharge`/`getBalance` existentes.

**Tech Stack:** NestJS, Prisma, Jest (backend e2e); React/Vite, TanStack Query, qrcode.react, Vitest (front).

## Global Constraints

- `GET /wallet/balance` exige `@Roles('CLIENT')`; retorna `{ balance: string }` de `LedgerService.getBalance('client:<req.user.id>')` (`.toString()`).
- `POST /wallet/recharge/:id/dev-confirm` só responde com `process.env.DEV_LOGIN === 'true'` E `process.env.NODE_ENV !== 'production'`; senão `404`. A recarga precisa pertencer ao usuário (`r.userId === req.user.id`, senão `404`). Confirma via `confirmRecharge(r.pspChargeId ?? '', r.amount)`.
- Botão "Já paguei (simular)" só quando `import.meta.env.VITE_DEV_LOGIN === 'true'`.
- Backend: `npx tsc --noEmit` limpo. Front: `npm run build` limpo (gate real é o build/`tsc -b`, não só `tsc --noEmit`).
- `import type` em interfaces/tipos injetados. Não alterar lógica financeira; reusar `confirmRecharge`/`getBalance`.
- Front: tudo testado com boundary de API mockado (sem backend/credencial real).

---

## File Structure

```
src/wallet/wallet-balance.controller.ts   GET /wallet/balance                       [novo]
src/wallet/recharge.controller.ts         + POST :id/dev-confirm                     [mod]
src/wallet/wallet.module.ts               + WalletBalanceController                  [mod]
test/wallet.balance.e2e-spec.ts                                                     [novo]
test/wallet.dev-confirm.e2e-spec.ts                                                 [novo]
web/src/types/api.ts                      + Recharge type                            [mod]
web/src/wallet/useBalance.ts                                                        [novo]
web/src/wallet/useCreateRecharge.ts                                                 [novo]
web/src/wallet/useRecharge.ts                                                       [novo]
web/src/wallet/RechargePanel.tsx                                                    [novo]
web/src/wallet/WalletPage.tsx                                                       [novo]
web/src/wallet/wallet.test.tsx                                                      [novo]
web/src/App.tsx                           + rota /wallet                            [mod]
web/src/discovery/DiscoveryPage.tsx       + saldo/link no header                     [mod]
web/package.json                          + qrcode.react                            [mod]
```

Backend e2e: `npx jest --config ./jest-integration.json --runInBand <file>` (Docker test DB no ar). Front: `cd web && npx vitest run <file>`.

---

## Task 1: Backend — `GET /wallet/balance`

**Files:**
- Create: `src/wallet/wallet-balance.controller.ts`
- Modify: `src/wallet/wallet.module.ts`
- Test: `test/wallet.balance.e2e-spec.ts`

**Interfaces:**
- Consumes: `LedgerService.getBalance(account): Promise<Prisma.Decimal>`; `JwtAuthGuard`/`RolesGuard`/`@Roles`; `AuthUser` (`req.user.id`).
- Produces: `GET /wallet/balance` → `{ balance: string }`.

- [ ] **Step 1: Escrever o e2e que falha**

Create `test/wallet.balance.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /wallet/balance', () => {
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
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await app.close(); });

  async function client(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'CLIENT' }) };
  }

  it('retorna o saldo do cliente autenticado', async () => {
    const c = await client();
    await ledger.postTransaction(`seed:${c.id}`, [
      { account: `client:${c.id}`, entryType: 'RECARGA', amount: new Prisma.Decimal('30.00') },
      { account: 'source:external', entryType: 'SEED', amount: new Prisma.Decimal('-30.00') },
    ]);
    const res = await request(app.getHttpServer()).get('/wallet/balance').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body.balance).toBe('30');
  });

  it('saldo zero quando não há lançamentos', async () => {
    const c = await client();
    const res = await request(app.getHttpServer()).get('/wallet/balance').set('Authorization', `Bearer ${c.token}`).expect(200);
    expect(res.body.balance).toBe('0');
  });

  it('sem token → 401', async () => {
    await request(app.getHttpServer()).get('/wallet/balance').expect(401);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.balance.e2e-spec.ts`
Expected: FAIL — rota inexistente (404 nos 200-tests).

- [ ] **Step 3: Criar o controller**

Create `src/wallet/wallet-balance.controller.ts`:
```ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LedgerService } from '../ledger/ledger.service';

@Controller('wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
export class WalletBalanceController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('balance')
  @Roles('CLIENT')
  async balance(@Req() req: Request & { user: AuthUser }): Promise<{ balance: string }> {
    const b = await this.ledger.getBalance(`client:${req.user.id}`);
    return { balance: b.toString() };
  }
}
```

- [ ] **Step 4: Registrar no WalletModule**

In `src/wallet/wallet.module.ts`, import `WalletBalanceController` and add it to the `controllers` array (alongside `WalletController, RechargeController`). Add:
```ts
import { WalletBalanceController } from './wallet-balance.controller';
```
and update `controllers: [WalletController, RechargeController, WalletBalanceController],`.

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.balance.e2e-spec.ts`
Expected: PASS (3/3).

- [ ] **Step 6: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/wallet/wallet-balance.controller.ts src/wallet/wallet.module.ts test/wallet.balance.e2e-spec.ts
git commit -m "feat(wallet): GET /wallet/balance (saldo do cliente)"
```

---

## Task 2: Backend — `POST /wallet/recharge/:id/dev-confirm` (dev-only)

**Files:**
- Modify: `src/wallet/recharge.controller.ts`
- Test: `test/wallet.dev-confirm.e2e-spec.ts`

**Interfaces:**
- Consumes: `WalletService.confirmRecharge(pspChargeId, amount)`, `PrismaService` (ambos já injetados no RechargeController); `AuthUser`.
- Produces: `POST /wallet/recharge/:id/dev-confirm` → resultado de `confirmRecharge` (dev-only) ou `404`.

- [ ] **Step 1: Escrever o e2e que falha**

Create `test/wallet.dev-confirm.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { TokenService } from '../src/auth/token.service';

describe('POST /wallet/recharge/:id/dev-confirm', () => {
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
    await prisma.recharge.deleteMany();
    await prisma.ledgerEntry.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN; else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  async function clientWithPending(): Promise<{ id: string; token: string; rechargeId: string }> {
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    const r = await prisma.recharge.create({ data: { userId: u.id, amount: new Prisma.Decimal('20.00'), status: 'PENDING', pspChargeId: `chg-${u.id}` } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'CLIENT' }), rechargeId: r.id };
  }

  it('com DEV_LOGIN=true confirma a recarga e credita o saldo', async () => {
    process.env.DEV_LOGIN = 'true';
    const c = await clientWithPending();
    await request(app.getHttpServer()).post(`/wallet/recharge/${c.rechargeId}/dev-confirm`).set('Authorization', `Bearer ${c.token}`).expect(201);
    expect((await ledger.getBalance(`client:${c.id}`)).toString()).toBe('20');
    const r = await prisma.recharge.findUnique({ where: { id: c.rechargeId } });
    expect(r?.status).toBe('PAID');
  });

  it('com DEV_LOGIN desativado → 404', async () => {
    delete process.env.DEV_LOGIN;
    const c = await clientWithPending();
    await request(app.getHttpServer()).post(`/wallet/recharge/${c.rechargeId}/dev-confirm`).set('Authorization', `Bearer ${c.token}`).expect(404);
    expect((await ledger.getBalance(`client:${c.id}`)).toString()).toBe('0');
  });

  it('recarga de outro usuário → 404', async () => {
    process.env.DEV_LOGIN = 'true';
    const owner = await clientWithPending();
    const other = await prisma.user.create({ data: { id: `o-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'o@x.com', displayName: 'O', status: 'ACTIVE' } });
    const otherToken = tokens.signAccess({ id: other.id, role: 'CLIENT' });
    await request(app.getHttpServer()).post(`/wallet/recharge/${owner.rechargeId}/dev-confirm`).set('Authorization', `Bearer ${otherToken}`).expect(404);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.dev-confirm.e2e-spec.ts`
Expected: FAIL — rota inexistente.

- [ ] **Step 3: Adicionar a rota dev-confirm**

In `src/wallet/recharge.controller.ts`, add the route inside the class (after the `@Get(':id')` method). The needed imports (`NotFoundException`, `Param`, `Post`, `Req`, `WalletService`, `PrismaService`, `AuthUser`) are already present:
```ts
  @Post(':id/dev-confirm')
  async devConfirm(@Req() req: Request & { user: AuthUser }, @Param('id') id: string): Promise<unknown> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const r = await this.prisma.recharge.findUnique({ where: { id } });
    if (!r || r.userId !== req.user.id) {
      throw new NotFoundException('recharge not found');
    }
    return this.wallet.confirmRecharge(r.pspChargeId ?? '', r.amount);
  }
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/wallet.dev-confirm.e2e-spec.ts`
Expected: PASS (3/3).

- [ ] **Step 5: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/wallet/recharge.controller.ts test/wallet.dev-confirm.e2e-spec.ts
git commit -m "feat(wallet): dev-confirm de recarga (dev-only) pra fechar o fluxo sem PSP"
```

---

## Task 3: Frontend — página da carteira (saldo + recarga + QR + polling)

**Files:**
- Modify: `web/package.json` (qrcode.react), `web/src/types/api.ts` (Recharge), `web/src/App.tsx` (rota)
- Create: `web/src/wallet/useBalance.ts`, `useCreateRecharge.ts`, `useRecharge.ts`, `RechargePanel.tsx`, `WalletPage.tsx`, `wallet.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` (lib/api-client); `import.meta.env.VITE_DEV_LOGIN`.
- Produces: `useBalance()`, `useCreateRecharge()`, `useRecharge(id)`, `<WalletPage>` na rota `/wallet`; tipo `Recharge`.

- [ ] **Step 1: Instalar qrcode.react**

Run (in `web/`): `npm i qrcode.react`

- [ ] **Step 2: Tipo Recharge**

In `web/src/types/api.ts`, add:
```ts
export interface Recharge {
  id: string;
  amount: string;
  status: 'PENDING' | 'PAID' | 'FAILED';
  qrText: string | null;
  expiresAt: string | null;
  paidAt?: string | null;
}
```

- [ ] **Step 3: Escrever os testes que falham**

Create `web/src/wallet/wallet.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WalletPage } from './WalletPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('WalletPage', () => {
  it('mostra o saldo atual', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '15' }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<WalletPage />));
    await waitFor(() => expect(screen.getByText(/15/)).toBeInTheDocument());
  });

  it('criar recarga mostra o QR e o status pendente', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/wallet/recharge') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: '00020126ABC', expiresAt: null }));
      if (u.endsWith('/wallet/recharge/r1')) return Promise.resolve(json(200, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: '00020126ABC', expiresAt: null }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<WalletPage />));
    await screen.findByText(/saldo/i);
    await userEvent.clear(screen.getByLabelText(/valor/i));
    await userEvent.type(screen.getByLabelText(/valor/i), '20');
    await userEvent.click(screen.getByRole('button', { name: /gerar/i }));
    await waitFor(() => expect(screen.getByText(/aguardando pagamento/i)).toBeInTheDocument());
    expect(screen.getByText('00020126ABC')).toBeInTheDocument();
  });

  it('quando a recarga vira PAID mostra confirmação', async () => {
    let polls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/wallet/recharge') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: 'x', expiresAt: null }));
      if (u.endsWith('/wallet/recharge/r1')) { polls += 1; return Promise.resolve(json(200, { id: 'r1', amount: '20.00', status: polls > 1 ? 'PAID' : 'PENDING', qrText: 'x', expiresAt: null, paidAt: polls > 1 ? '2026-06-28' : null })); }
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<WalletPage />));
    await screen.findByText(/saldo/i);
    await userEvent.click(screen.getByRole('button', { name: /gerar/i }));
    await waitFor(() => expect(screen.getByText(/confirmada/i)).toBeInTheDocument(), { timeout: 6000 });
  });

  it('botão dev aparece com VITE_DEV_LOGIN e chama dev-confirm', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/wallet/balance')) return Promise.resolve(json(200, { balance: '0' }));
      if (u.endsWith('/wallet/recharge') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: 'x', expiresAt: null }));
      if (u.endsWith('/wallet/recharge/r1/dev-confirm')) return Promise.resolve(json(201, { credited: true }));
      if (u.endsWith('/wallet/recharge/r1')) return Promise.resolve(json(200, { id: 'r1', amount: '20.00', status: 'PENDING', qrText: 'x', expiresAt: null }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<WalletPage />));
    await screen.findByText(/saldo/i);
    await userEvent.click(screen.getByRole('button', { name: /gerar/i }));
    await screen.findByRole('button', { name: /já paguei/i });
    await userEvent.click(screen.getByRole('button', { name: /já paguei/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/wallet/recharge/r1/dev-confirm'))).toBe(true));
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/wallet/wallet.test.tsx`
Expected: FAIL — WalletPage não existe.

- [ ] **Step 5: Hooks**

Create `web/src/wallet/useBalance.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useBalance(): ReturnType<typeof useQuery<{ balance: string }>> {
  return useQuery<{ balance: string }>({
    queryKey: ['balance'],
    queryFn: () => apiFetch<{ balance: string }>('/wallet/balance', { auth: true }),
  });
}
```

Create `web/src/wallet/useCreateRecharge.ts`:
```ts
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Recharge } from '../types/api';

export function useCreateRecharge(): ReturnType<typeof useMutation<Recharge, Error, string>> {
  return useMutation<Recharge, Error, string>({
    mutationFn: (amount: string) => apiFetch<Recharge>('/wallet/recharge', { method: 'POST', body: { amount }, auth: true }),
  });
}
```

Create `web/src/wallet/useRecharge.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Recharge } from '../types/api';

export function useRecharge(id: string | null): ReturnType<typeof useQuery<Recharge>> {
  return useQuery<Recharge>({
    queryKey: ['recharge', id],
    queryFn: () => apiFetch<Recharge>(`/wallet/recharge/${id}`, { auth: true }),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.status === 'PAID' ? false : 3000),
  });
}
```

- [ ] **Step 6: RechargePanel**

Create `web/src/wallet/RechargePanel.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { apiFetch } from '../lib/api-client';
import { useCreateRecharge } from './useCreateRecharge';
import { useRecharge } from './useRecharge';

export function RechargePanel(): JSX.Element {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('20');
  const [rechargeId, setRechargeId] = useState<string | null>(null);
  const create = useCreateRecharge();
  const { data: recharge } = useRecharge(rechargeId);
  const devEnabled = import.meta.env.VITE_DEV_LOGIN === 'true';

  useEffect(() => {
    if (recharge?.status === 'PAID') {
      void qc.invalidateQueries({ queryKey: ['balance'] });
    }
  }, [recharge?.status, qc]);

  const submit = (): void => {
    create.mutate(amount, { onSuccess: (r) => setRechargeId(r.id) });
  };

  const devConfirm = (): void => {
    if (!rechargeId) return;
    void apiFetch(`/wallet/recharge/${rechargeId}/dev-confirm`, { method: 'POST', auth: true }).then(() => {
      void qc.invalidateQueries({ queryKey: ['recharge', rechargeId] });
    });
  };

  if (recharge?.status === 'PAID') {
    return (
      <div className="mt-8 rounded-2xl bg-velvet p-6 text-center">
        <p className="text-gold">Recarga confirmada ✓</p>
        <button onClick={() => { setRechargeId(null); }} className="mt-4 text-mist text-sm hover:text-cream">nova recarga</button>
      </div>
    );
  }

  if (recharge && recharge.status === 'PENDING') {
    return (
      <div className="mt-8 rounded-2xl bg-velvet p-6 text-center">
        <p className="text-mist text-sm">Aguardando pagamento…</p>
        {recharge.qrText && (
          <div className="mt-4 flex flex-col items-center gap-3">
            <div className="rounded-xl bg-cream p-3"><QRCodeSVG value={recharge.qrText} size={180} /></div>
            <code className="block max-w-xs break-all text-xs text-mist">{recharge.qrText}</code>
          </div>
        )}
        {devEnabled && (
          <button onClick={devConfirm} className="mt-5 rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember">
            Já paguei (simular)
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-8 rounded-2xl bg-velvet p-6">
      <label htmlFor="amount" className="block text-mist text-sm">Valor (créditos)</label>
      <input
        id="amount"
        type="number"
        min="5"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="mt-2 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember"
      />
      <button
        onClick={submit}
        disabled={create.isPending}
        className="mt-4 w-full rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50"
      >
        {create.isPending ? 'Gerando…' : 'Gerar QR de recarga'}
      </button>
      {create.isError && <p className="mt-3 text-sm text-ember">Não foi possível criar a recarga. Tente de novo.</p>}
    </div>
  );
}
```

- [ ] **Step 7: WalletPage**

Create `web/src/wallet/WalletPage.tsx`:
```tsx
import { Link } from 'react-router-dom';
import { useBalance } from './useBalance';
import { RechargePanel } from './RechargePanel';

export function WalletPage(): JSX.Element {
  const { data, isLoading } = useBalance();

  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <Link to="/" className="text-mist text-sm hover:text-cream">← voltar</Link>
      <h1 className="mt-6 font-display text-4xl text-cream">Carteira</h1>
      <section className="mt-6 rounded-2xl bg-velvet p-6">
        <p className="text-mist text-sm">Saldo</p>
        <p className="mt-1 font-mono text-3xl text-cream">
          ⌗ {isLoading ? '…' : data?.balance ?? '0'} <span className="text-base text-mist">créditos</span>
        </p>
      </section>
      <RechargePanel />
    </main>
  );
}
```

- [ ] **Step 8: Rota /wallet**

In `web/src/App.tsx`, import `WalletPage` and add the protected route:
```tsx
import { WalletPage } from './wallet/WalletPage';
```
Add inside `<Routes>`:
```tsx
      <Route path="/wallet" element={<ProtectedRoute><WalletPage /></ProtectedRoute>} />
```

- [ ] **Step 9: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/wallet/wallet.test.tsx`
Expected: PASS (4/4).

- [ ] **Step 10: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/package.json web/package-lock.json web/src/types/api.ts web/src/wallet web/src/App.tsx
git commit -m "feat(web): carteira — saldo + criar recarga + QR + polling + dev-confirm"
```

---

## Task 4: Frontend — saldo + link no header da descoberta

**Files:**
- Modify: `web/src/discovery/DiscoveryPage.tsx`
- Test: `web/src/discovery/discovery.test.tsx` (atualizar o mock pra cobrir /wallet/balance)

**Interfaces:**
- Consumes: `useBalance()` (Task 3); react-router `Link`.

- [ ] **Step 1: Atualizar o teste de discovery pra tolerar a chamada de saldo**

In `web/src/discovery/discovery.test.tsx`, the existing tests stub `fetch` to return the models array for any call. Adding `useBalance` makes the page also call `/wallet/balance`. Update the three `vi.stubGlobal('fetch', ...)` mocks to route by URL so `/wallet/balance` returns a balance and `/models` returns the list. Replace each single-return mock with:
```ts
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/wallet/balance')) return Promise.resolve(jsonResponse(200, { balance: '0' }));
      return Promise.resolve(jsonResponse(200, /* the body that test already used: cards / [] / error */));
    }));
```
For the error test, keep `/models` returning the 500 (and `/wallet/balance` 200) so the page still shows the error state for the list. Add a new assertion to the first test: `expect(screen.getByText(/carteira/i)).toBeInTheDocument();`.

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/discovery/discovery.test.tsx`
Expected: FAIL — o link "Carteira" ainda não existe (nova asserção).

- [ ] **Step 3: Header com saldo + link**

In `web/src/discovery/DiscoveryPage.tsx`, import `useBalance` and `Link`, call the hook, and put the balance + a "Carteira" link in the header next to "sair":
```tsx
import { Link } from 'react-router-dom';
import { useBalance } from '../wallet/useBalance';
```
In the component body add `const { data: bal } = useBalance();` and change the header to:
```tsx
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="font-display text-4xl text-cream">Quem você quer ouvir?</h1>
        <div className="flex items-baseline gap-4 text-sm">
          <Link to="/wallet" className="font-mono text-cream hover:text-ember">⌗ {bal?.balance ?? '…'} · Carteira</Link>
          <button onClick={() => void logout()} className="text-mist hover:text-cream">sair</button>
        </div>
      </header>
```

- [ ] **Step 4: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/discovery/discovery.test.tsx`
Expected: PASS.

- [ ] **Step 5: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/discovery
git commit -m "feat(web): saldo + link Carteira no header da descoberta"
```

---

## Task 5: Verificação final + push

- [ ] **Step 1: Suíte backend completa**

Run: `npm run test:int`
Expected: tudo verde (incl. wallet.balance + wallet.dev-confirm).

- [ ] **Step 2: Front — suíte + build**

Run (in `web/`): `npx vitest run` e `npm run build`
Expected: tudo verde; build limpo.

- [ ] **Step 3: Verificação manual (stack já no ar)**

Garanta `web/.env` com `VITE_DEV_LOGIN="true"` e `.env` (raiz) com `DEV_LOGIN=true`. Reinicie o backend se preciso (`npm run start:dev`). No navegador: logar como teste → header mostra "⌗ 0 · Carteira" → abrir Carteira → adicionar 20 → ver QR → "Já paguei (simular)" → "Recarga confirmada" e saldo = 20.

- [ ] **Step 4: Commit (se algo mudou) e push**

```bash
git push origin main
```

---

## Self-Review (autor)

**Cobertura do spec:**
- §3/§4.1 GET /wallet/balance → Task 1 (+e2e 3). ✓
- §3/§4.2 dev-confirm dev-only + dono → Task 2 (+e2e on/off/alheio). ✓
- §4.3 hooks (balance/create/recharge poll) → Task 3. ✓
- §4.4 WalletPage/RechargePanel (QR, polling, PAID, botão dev) → Task 3 (+4 testes). ✓
- §4.5 rota /wallet + header com saldo/link → Tasks 3/4. ✓
- §6 testes backend + front mockado → Tasks 1–4. ✓
- §7 verificação manual → Task 5. ✓

**Consistência de tipos:** `Recharge {id,amount,status,qrText,expiresAt,paidAt?}` (front) bate com o retorno do backend; `useBalance` → `{balance:string}`; `confirmRecharge(pspChargeId, amount)` reusado; `getBalance('client:<id>').toString()`. Rota dev-confirm `/wallet/recharge/:id/dev-confirm` idêntica no back/front/testes.

**Placeholders:** o Task 4 Step 1 descreve a edição do mock com o corpo "que o teste já usava" — é instrução de edição sobre código existente (não placeholder de código novo); cada caso (cards/[]/500) é nomeado. Demais passos têm código concreto.

**Nota:** gate de tipos do front é `npm run build` (tsc -b), usado nos commits das tasks de front.
