# Painel da Modelo #3 (KYC) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A modelo vê e inicia o KYC no painel; um dev-approve aprova direto, fechando o ciclo até o saque.

**Architecture:** Reusa `GET /kyc/me` e `POST /kyc/start`. Adiciona um `POST /kyc/dev-approve` (dev-only) que aprova o KYC da modelo (KycVerification APPROVED + KycStatus approved + promove user). Front: KycPanel no `/painel`.

**Tech Stack:** NestJS/Prisma, Jest e2e; React/Vite, TanStack Query, Vitest.

## Global Constraints

- `POST /kyc/dev-approve` só com `DEV_LOGIN==='true'` E `NODE_ENV!=='production'` (senão `404`). Aprova o KYC da própria modelo (conta via `UsersService.accountOf`): upsert `KycVerification(providerRef:'dev:'+account, status:'APPROVED')` + upsert `KycStatus(approved:true)` + se user `PENDING_VERIFICATION`→`ACTIVE`.
- `/kyc/*` é `@Roles('MODEL')` (já é); conta deriva de `req.user.id` (nunca do body).
- Não alterar `start`/`applyResult`/`getLatest`.
- Front: botão dev só com `VITE_DEV_LOGIN==='true'`; "Iniciar verificação" trata erro de provedor com mensagem clara.
- `import type` em interfaces. Backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo. Front testa com boundary mockado.

---

## File Structure

```
src/kyc-verification/kyc-verification.service.ts    + devApprove                         [mod]
src/kyc-verification/kyc-verification.controller.ts + POST dev-approve                    [mod]
test/kyc.dev-approve.e2e-spec.ts                                                          [novo]
web/src/types/api.ts                                + KycStatusView                        [mod]
web/src/model/useKyc.ts                                                                   [novo]
web/src/model/KycPanel.tsx                                                                [novo]
web/src/model/ModelDashboard.tsx                    + <KycPanel/> antes de EarningsPanel   [mod]
web/src/model/kyc.test.tsx                                                                [novo]
```

Backend e2e: `npx jest --config ./jest-integration.json --runInBand <file>`. Front: `cd web && npx vitest run <file>`.

---

## Task 1: Backend — `POST /kyc/dev-approve`

**Files:**
- Modify: `src/kyc-verification/kyc-verification.service.ts`, `src/kyc-verification/kyc-verification.controller.ts`
- Test: `test/kyc.dev-approve.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (na service); `UsersService.accountOf({id, role})`.
- Produces: `KycVerificationService.devApprove(account: string, userId: string): Promise<void>`; `POST /kyc/dev-approve` → `{ ok: true }` (dev-only).

- [ ] **Step 1: Escrever o e2e que falha**

Create `test/kyc.dev-approve.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('POST /kyc/dev-approve', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  const prev = process.env.DEV_LOGIN;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => {
    await prisma.kycVerification.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN; else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  async function model(): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `m-${Math.random().toString(36).slice(2)}`, role: 'MODEL', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'm@x.com', displayName: 'M', status: 'PENDING_VERIFICATION' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role: 'MODEL' }) };
  }

  it('dev-approve (DEV_LOGIN=true) aprova KYC e promove o user a ACTIVE', async () => {
    process.env.DEV_LOGIN = 'true';
    const m = await model();
    await request(app.getHttpServer()).post('/kyc/dev-approve').set('Authorization', `Bearer ${m.token}`).expect(201);
    const status = await request(app.getHttpServer()).get('/kyc/me').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(status.body.status).toBe('APPROVED');
    const ks = await prisma.kycStatus.findUnique({ where: { account: `model:${m.id}` } });
    expect(ks?.approved).toBe(true);
    const u = await prisma.user.findUnique({ where: { id: m.id } });
    expect(u?.status).toBe('ACTIVE');
  });

  it('dev-approve desligado → 404', async () => {
    delete process.env.DEV_LOGIN;
    const m = await model();
    await request(app.getHttpServer()).post('/kyc/dev-approve').set('Authorization', `Bearer ${m.token}`).expect(404);
  });

  it('CLIENT em /kyc/dev-approve → 403', async () => {
    process.env.DEV_LOGIN = 'true';
    const u = await prisma.user.create({ data: { id: `c-${Math.random().toString(36).slice(2)}`, role: 'CLIENT', provider: 'google', providerSubject: `s-${Math.random()}`, email: 'c@x.com', displayName: 'C', status: 'ACTIVE' } });
    const token = tokens.signAccess({ id: u.id, role: 'CLIENT' });
    await request(app.getHttpServer()).post('/kyc/dev-approve').set('Authorization', `Bearer ${token}`).expect(403);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/kyc.dev-approve.e2e-spec.ts`
Expected: FAIL — rota inexistente.

- [ ] **Step 3: `devApprove` na service**

In `src/kyc-verification/kyc-verification.service.ts`, add this method to the class (constructor already injects `prisma`):
```ts
  async devApprove(account: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.kycVerification.upsert({
        where: { providerRef: `dev:${account}` },
        update: { status: 'APPROVED', resolvedAt: now },
        create: {
          account,
          userId,
          status: 'APPROVED',
          providerRef: `dev:${account}`,
          clientToken: 'dev',
          sessionExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          resolvedAt: now,
        },
      });
      await tx.kycStatus.upsert({ where: { account }, update: { approved: true }, create: { account, approved: true } });
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (user && user.status === 'PENDING_VERIFICATION') {
        await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
      }
    });
  }
```

- [ ] **Step 4: Rota dev-approve no controller**

In `src/kyc-verification/kyc-verification.controller.ts`, add `NotFoundException` and `Body` are not needed; add `NotFoundException` to the `@nestjs/common` import (currently `{ Controller, Get, Post, Req, UseGuards }`). Add the route inside the class (after `me`):
```ts
  @Post('dev-approve')
  async devApprove(@Req() req: Request & { user: AuthUser }): Promise<{ ok: true }> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const account = this.users.accountOf({ id: req.user.id, role: req.user.role });
    await this.kyc.devApprove(account, req.user.id);
    return { ok: true };
  }
```
Update the import line to: `import { Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';`.

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/kyc.dev-approve.e2e-spec.ts`
Expected: PASS (3/3).

- [ ] **Step 6: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/kyc-verification/kyc-verification.service.ts src/kyc-verification/kyc-verification.controller.ts test/kyc.dev-approve.e2e-spec.ts
git commit -m "feat(kyc): dev-approve (dev-only) — aprova KYC da modelo e promove a ACTIVE"
```

---

## Task 2: Frontend — KycPanel no /painel

**Files:**
- Modify: `web/src/types/api.ts`, `web/src/model/ModelDashboard.tsx`
- Create: `web/src/model/useKyc.ts`, `web/src/model/KycPanel.tsx`, `web/src/model/kyc.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`. Produces: `<KycPanel/>`; `useKyc()`; tipo `KycStatusView`.

- [ ] **Step 1: Tipo KycStatusView**

In `web/src/types/api.ts`, add:
```ts
export interface KycStatusView {
  status: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
  reason?: string;
  createdAt?: string;
  resolvedAt?: string;
}
```

- [ ] **Step 2: Escrever os testes (falham)**

Create `web/src/model/kyc.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KycPanel } from './KycPanel';
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

describe('KycPanel', () => {
  it('mostra status NÃO iniciada e o botão de iniciar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/kyc/me')) return Promise.resolve(json(200, { status: 'NONE' }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<KycPanel />));
    await waitFor(() => expect(screen.getByRole('button', { name: /iniciar verifica/i })).toBeInTheDocument());
  });

  it('status APPROVED renderiza "aprovada"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith('/kyc/me')) return Promise.resolve(json(200, { status: 'APPROVED' }));
      return Promise.resolve(json(200, {}));
    }));
    render(wrap(<KycPanel />));
    await waitFor(() => expect(screen.getByText(/aprovada/i)).toBeInTheDocument());
  });

  it('botão dev aparece com VITE_DEV_LOGIN e chama /kyc/dev-approve', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/kyc/dev-approve')) return Promise.resolve(json(201, { ok: true }));
      if (u.endsWith('/kyc/me')) return Promise.resolve(json(200, { status: 'NONE' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<KycPanel />));
    await userEvent.click(await screen.findByRole('button', { name: /aprovar kyc/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/kyc/dev-approve'))).toBe(true));
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/model/kyc.test.tsx`
Expected: FAIL — `KycPanel` não existe.

- [ ] **Step 4: useKyc**

Create `web/src/model/useKyc.ts`:
```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { KycStatusView } from '../types/api';

export function useKyc(): {
  status: ReturnType<typeof useQuery<KycStatusView>>;
  start: ReturnType<typeof useMutation<unknown, Error, void>>;
  devApprove: ReturnType<typeof useMutation<unknown, Error, void>>;
} {
  const qc = useQueryClient();
  const status = useQuery<KycStatusView>({
    queryKey: ['kyc'],
    queryFn: () => apiFetch<KycStatusView>('/kyc/me', { auth: true }),
  });
  const start = useMutation<unknown, Error, void>({
    mutationFn: () => apiFetch('/kyc/start', { method: 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kyc'] }); },
  });
  const devApprove = useMutation<unknown, Error, void>({
    mutationFn: () => apiFetch('/kyc/dev-approve', { method: 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['kyc'] }); },
  });
  return { status, start, devApprove };
}
```

- [ ] **Step 5: KycPanel**

Create `web/src/model/KycPanel.tsx`:
```tsx
import { useKyc } from './useKyc';

const LABEL: Record<string, string> = {
  NONE: 'não iniciada',
  PENDING: 'em análise',
  APPROVED: 'aprovada ✓',
  REJECTED: 'recusada',
};

export function KycPanel(): JSX.Element {
  const { status, start, devApprove } = useKyc();
  const devEnabled = import.meta.env.VITE_DEV_LOGIN === 'true';
  const s = status.data?.status ?? 'NONE';

  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <div className="flex items-baseline justify-between">
        <p className="text-mist text-sm">Verificação (KYC)</p>
        <span className={`text-xs uppercase tracking-wide ${s === 'APPROVED' ? 'text-gold' : s === 'REJECTED' ? 'text-ember' : 'text-mist'}`}>
          {LABEL[s] ?? s}
        </span>
      </div>
      {status.data?.status === 'REJECTED' && status.data.reason && (
        <p className="mt-2 text-ember text-sm">{status.data.reason}</p>
      )}

      {s !== 'APPROVED' && (
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={start.isPending}
            className="rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50"
          >
            {start.isPending ? 'Iniciando…' : 'Iniciar verificação'}
          </button>
          {devEnabled && (
            <button
              type="button"
              onClick={() => devApprove.mutate()}
              className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
            >
              Aprovar KYC (simular)
            </button>
          )}
        </div>
      )}

      {start.isError && <p className="mt-3 text-ember text-sm">Verificação indisponível no momento.</p>}
      {s === 'APPROVED' && <p className="mt-3 text-gold text-sm">Identidade verificada — você pode sacar.</p>}
    </section>
  );
}
```

- [ ] **Step 6: Wire no ModelDashboard**

In `web/src/model/ModelDashboard.tsx`, import `KycPanel` and render it before `<EarningsPanel />`:
```tsx
import { KycPanel } from './KycPanel';
```
In the JSX, between `<ProfileForm />` and `<EarningsPanel />` (ou após o ProfileForm, antes do EarningsPanel):
```tsx
      <KycPanel />
```

- [ ] **Step 7: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/model/kyc.test.tsx`
Expected: PASS (3/3). Depois `npx vitest run` (suíte inteira) verde.

- [ ] **Step 8: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/types/api.ts web/src/model
git commit -m "feat(web): painel — KYC (status + iniciar + aprovar simular)"
```

---

## Task 3: Verificação final + push

- [ ] **Step 1:** `npm run test:int` → verde.
- [ ] **Step 2:** (in `web/`) `npx vitest run` e `npm run build` → verdes.
- [ ] **Step 3 (manual — fecha o ciclo):** `/painel` como modelo → KYC "não iniciada" → "Aprovar KYC (simular)" → "aprovada ✓" → Ganhos: "Creditar ganhos de teste" → "Solicitar saque" passa (sem 403).
- [ ] **Step 4:** `git push origin main`.

---

## Self-Review (autor)

**Cobertura do spec:** §4.1 devApprove + rota dev-approve (dupla-trava) → T1 (+e2e approve/off/CLIENT); §4.2 useKyc + KycPanel + wire → T2 (+3 testes); §6 testes → T1/T2; §7 ciclo manual → T3.

**Consistência de tipos:** `devApprove(account, userId)`; `accountOf({id, role})` reusado; rota `/kyc/dev-approve` idêntica back/front; `KycStatusView.status` ('NONE'|'PENDING'|'APPROVED'|'REJECTED') casa com `getLatest`. Reusa `/kyc/me` e `/kyc/start` inalterados.

**Placeholders:** nenhum — código/comando concreto. Gate de tipos do front = `npm run build`.
