# Painel admin (UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin lista usuários e ativa/suspende por uma UI em `/admin`, acessível em dev via login admin.

**Architecture:** Novo `GET /admin/users` (ADMIN) sobre `UsersService.listUsers`; dev-login estendido pra ADMIN; painel React gated por role que lista e chama os endpoints activate/suspend existentes.

**Tech Stack:** NestJS + Prisma (back); Vite + React 18 + TanStack Query v5 + Vitest (front).

## Global Constraints
- `GET /admin/users` é `@Roles('ADMIN')` (não-admin → 403). Resposta `{ id, role, status, email, displayName, createdAt }[]`, `orderBy createdAt desc`, `take 200`. Filtros opcionais `role`/`status` por query.
- `dev-login` ADMIN só com `DEV_LOGIN='true'` e `NODE_ENV !== 'production'` (duplo-gate já existente).
- Front `/admin` → `<Navigate to="/" />` se `user.role !== 'ADMIN'`. Activate/suspend invalidam `['admin-users']`.
- `import type` em imports de tipo. Backend gate `npx tsc --noEmit`. Front gate `npm run build` (tsc -b strict). e2e via `jest-integration.json` (Postgres de teste no ar). Front com `fetch` mockado + `setSession`.

---

### Task 1: Backend — listar usuários + dev-login ADMIN

**Files:**
- Modify: `src/users/users.service.ts` (`CreateUserInput.role` aceita ADMIN; status ADMIN→ACTIVE; novo `listUsers`)
- Modify: `src/admin/admin.controller.ts` (+ `GET /admin/users`)
- Modify: `src/auth/auth.controller.ts` (dev-login aceita ADMIN)
- Modify: `src/auth/auth.service.ts` (`devLogin` trata ADMIN)
- Test: `test/admin.users.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `UsersService`, `Roles('ADMIN')`, dev-login.
- Produces: `UsersService.listUsers(filter?: { role?: string; status?: string }): Promise<User[]>`; `GET /admin/users`; `devLogin('ADMIN')`.

- [ ] **Step 1: Write the failing e2e test**

Harness no estilo do `test/admin.e2e-spec.ts` (FakeIdentityProvider + promoção a ADMIN). Para o dev-login ADMIN, garanta que o ambiente de teste tem `DEV_LOGIN='true'` (o `.env.test` já habilita o dev-login dos outros testes; se não, semeie via promoção como no admin.e2e).

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('GET /admin/users', () => {
  let app: INestApplication; let prisma: PrismaService; let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider).compile();
    app = mod.createNestApplication({ rawBody: true }); await app.init();
    prisma = mod.get(PrismaService); fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => { fake.reset(); await prisma.refreshToken.deleteMany(); await prisma.modelProfile.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });
  function http() { return request(app.getHttpServer()); }

  async function adminToken(): Promise<string> {
    fake.register('tok-admin', { provider: 'google', subject: 'admin1', email: 'admin@x.com', name: 'Admin' });
    await http().post('/auth/google').send({ idToken: 'tok-admin', role: 'CLIENT' });
    const u = await prisma.user.findFirst({ where: { providerSubject: 'admin1' } });
    await prisma.user.update({ where: { id: u!.id }, data: { role: 'ADMIN' } });
    const res = await http().post('/auth/google').send({ idToken: 'tok-admin' });
    return res.body.accessToken;
  }
  async function makeUser(sub: string, role: string): Promise<string> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    const u = await prisma.user.findFirst({ where: { providerSubject: sub } });
    return u!.id;
  }

  it('admin lista usuários e filtra por status', async () => {
    const token = await adminToken();
    await makeUser('mod1', 'MODEL');   // PENDING_VERIFICATION
    await makeUser('cli1', 'CLIENT');  // ACTIVE

    const all = await http().get('/admin/users').set('Authorization', `Bearer ${token}`).expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(3); // admin + mod + cli
    expect(all.body[0]).toHaveProperty('email');
    expect(all.body[0]).toHaveProperty('status');

    const pending = await http().get('/admin/users?status=PENDING_VERIFICATION').set('Authorization', `Bearer ${token}`).expect(200);
    expect(pending.body.every((u: { status: string }) => u.status === 'PENDING_VERIFICATION')).toBe(true);
    expect(pending.body).toHaveLength(1);
  });

  it('não-admin → 403', async () => {
    fake.register('tok-c', { provider: 'google', subject: 'c2', email: 'c2@x.com', name: 'C2' });
    const res = await http().post('/auth/google').send({ idToken: 'tok-c', role: 'CLIENT' });
    await http().get('/admin/users').set('Authorization', `Bearer ${res.body.accessToken}`).expect(403);
  });

  it('sem token → 401', async () => {
    await http().get('/admin/users').expect(401);
  });

  it('dev-login ADMIN retorna usuário ADMIN', async () => {
    const res = await http().post('/auth/dev-login').send({ role: 'ADMIN' }).expect(201);
    expect(res.body.user.role).toBe('ADMIN');
    expect(res.body.user.status).toBe('ACTIVE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

> e2e via integração (Postgres de teste no ar; se preciso `docker compose up -d`).

Run: `npx jest --config ./jest-integration.json --runInBand test/admin.users.e2e-spec.ts`
Expected: FAIL (`/admin/users` 404; dev-login ADMIN cai em CLIENT).

- [ ] **Step 3: `UsersService` — ADMIN + listUsers**

Em `src/users/users.service.ts`:
- Ampliar o tipo do input e o status default:
```ts
interface CreateUserInput {
  role: 'CLIENT' | 'MODEL' | 'ADMIN';
  provider: string;
  subject: string;
  email: string;
  name: string;
}
```
```ts
  createUser(input: CreateUserInput): Promise<User> {
    const status = input.role === 'MODEL' ? 'PENDING_VERIFICATION' : 'ACTIVE';
    return this.prisma.user.create({
      data: {
        role: input.role,
        provider: input.provider,
        providerSubject: input.subject,
        email: input.email,
        displayName: input.name,
        status,
      },
    });
  }
```
(ADMIN cai no ramo `!== 'MODEL'` → ACTIVE. Sem outra mudança nesse método.)
- Adicionar:
```ts
  listUsers(filter?: { role?: string; status?: string }): Promise<User[]> {
    return this.prisma.user.findMany({
      where: {
        ...(filter?.role ? { role: filter.role } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
```

- [ ] **Step 4: `AdminController` — GET /admin/users**

Em `src/admin/admin.controller.ts`, adicionar (importando `Get`, `Query`):
```ts
  @Get()
  async list(@Query('role') role?: string, @Query('status') status?: string): Promise<unknown> {
    const users = await this.users.listUsers({ role, status });
    return users.map((u) => ({
      id: u.id, role: u.role, status: u.status, email: u.email, displayName: u.displayName, createdAt: u.createdAt,
    }));
  }
```
Ajustar o import do topo: `import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';`.

- [ ] **Step 5: dev-login aceita ADMIN**

Em `src/auth/auth.controller.ts`, no handler `devLogin`:
```ts
  async devLogin(@Body() body?: { role?: string }): Promise<unknown> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    const role = body?.role === 'MODEL' ? 'MODEL' : body?.role === 'ADMIN' ? 'ADMIN' : 'CLIENT';
    return this.auth.devLogin(role);
  }
```
Em `src/auth/auth.service.ts`, generalizar `devLogin`:
```ts
  async devLogin(role: 'CLIENT' | 'MODEL' | 'ADMIN' = 'CLIENT'): Promise<AuthResult> {
    const provider = 'dev';
    const subject = role === 'MODEL' ? 'dev-model' : role === 'ADMIN' ? 'dev-admin' : 'dev-client';
    const email = role === 'MODEL' ? 'dev-model@samy.local' : role === 'ADMIN' ? 'dev-admin@samy.local' : 'dev@samy.local';
    const name = role === 'MODEL' ? 'Modelo Dev' : role === 'ADMIN' ? 'Admin Dev' : 'Cliente Dev';
    let user = await this.users.findByProvider(provider, subject);
    if (!user) {
      user = await this.users.createUser({ role, provider, subject, email, name });
    }
    if (role !== 'CLIENT' && user.status !== 'ACTIVE') {
      user = await this.users.setStatus(user.id, 'ACTIVE');
    }
    const refreshToken = await this.tokens.issueRefresh(user.id);
    return {
      accessToken: this.tokens.signAccess({ id: user.id, role: user.role }),
      refreshToken,
      user: { id: user.id, role: user.role, status: user.status, email: user.email, displayName: user.displayName },
    };
  }
```
(O `setStatus` aceita `'ACTIVE' | 'SUSPENDED'` — `'ACTIVE'` está ok.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest --config ./jest-integration.json --runInBand test/admin.users.e2e-spec.ts`
Expected: PASS (lista + filtro; 403; 401; dev-login ADMIN).

- [ ] **Step 7: Regression (admin activate/suspend + dev-login) + typecheck**

Run: `npx jest --config ./jest-integration.json --runInBand test/admin.e2e-spec.ts test/auth.dev-login.e2e-spec.ts` e `npx tsc --noEmit`
Expected: PASS / sem erros.

- [ ] **Step 8: Commit**

```bash
git add src/users/users.service.ts src/admin/admin.controller.ts src/auth/auth.controller.ts src/auth/auth.service.ts test/admin.users.e2e-spec.ts
git commit -m "feat(admin): GET /admin/users + dev-login ADMIN"
```

---

### Task 2: Frontend — painel `/admin`

**Files:**
- Modify: `web/src/types/api.ts` (+ `AdminUser`)
- Create: `web/src/admin/useAdminUsers.ts`
- Create: `web/src/admin/useSetUserStatus.ts`
- Create: `web/src/admin/AdminPage.tsx`
- Modify: `web/src/auth/auth-context.tsx` (`devLogin` aceita `'ADMIN'`)
- Modify: `web/src/auth/LoginPage.tsx` (+ botão admin dev)
- Modify: `web/src/App.tsx` (+ rota `/admin`)
- Test: `web/src/admin/admin.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`; `useAuth` (role gate); `useQuery`/`useMutation`; `Navigate`; tokens.
- Produces: `AdminUser`; `useAdminUsers()`; `useSetUserStatus()`; `<AdminPage />`.

- [ ] **Step 1: Add type to `web/src/types/api.ts`**

```ts
export interface AdminUser {
  id: string;
  role: string;
  status: string;
  email: string;
  displayName: string;
  createdAt: string;
}
```

- [ ] **Step 2: Write the failing test**

Boilerplate igual ao `web/src/gifts/gifts.test.tsx` (vitest imports, `setSession`, `json()`, MemoryRouter).

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AdminPage } from './AdminPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

function sessFor(role: string): Session {
  return { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role, status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
const users = [
  { id: 'm1', role: 'MODEL', status: 'PENDING_VERIFICATION', email: 'm@x.com', displayName: 'Mod', createdAt: '2026-06-29T00:00:00.000Z' },
  { id: 'c1', role: 'CLIENT', status: 'ACTIVE', email: 'c@x.com', displayName: 'Cli', createdAt: '2026-06-28T00:00:00.000Z' },
];
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('AdminPage', () => {
  it('lista usuários e ativar chama POST activate', async () => {
    setSession(sessFor('ADMIN'));
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/admin/users')) return Promise.resolve(json(200, users));
      if (u.includes('/activate') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'm1', status: 'ACTIVE' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<AdminPage />));
    await waitFor(() => expect(screen.getByText('Mod')).toBeInTheDocument());
    expect(screen.getByText('m@x.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /ativar/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/users/m1/activate') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
    });
  });

  it('não-admin é redirecionado (não mostra lista)', async () => {
    setSession(sessFor('CLIENT'));
    vi.stubGlobal('fetch', vi.fn(async () => json(200, users)));
    render(wrap(<AdminPage />));
    // Navigate to "/" → o conteúdo do painel não renderiza
    await waitFor(() => expect(screen.queryByText('Mod')).not.toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/admin/admin.test.tsx`
Expected: FAIL (AdminPage não existe).

- [ ] **Step 4: Implement `useAdminUsers.ts`**

```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { AdminUser } from '../types/api';

export function useAdminUsers(): ReturnType<typeof useQuery<AdminUser[]>> {
  return useQuery<AdminUser[]>({
    queryKey: ['admin-users'],
    queryFn: () => apiFetch<AdminUser[]>('/admin/users', { auth: true }),
  });
}
```

- [ ] **Step 5: Implement `useSetUserStatus.ts`**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

type Action = 'activate' | 'suspend';

export function useSetUserStatus(): ReturnType<typeof useMutation<unknown, Error, { id: string; action: Action }>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string; action: Action }>({
    mutationFn: ({ id, action }) => apiFetch(`/admin/users/${id}/${action}`, { method: 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });
}
```

- [ ] **Step 6: Implement `AdminPage.tsx`**

```tsx
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { useAdminUsers } from './useAdminUsers';
import { useSetUserStatus } from './useSetUserStatus';

export function AdminPage(): JSX.Element {
  const { user } = useAuth();
  const { data } = useAdminUsers();
  const setStatus = useSetUserStatus();
  if (user?.role !== 'ADMIN') return <Navigate to="/" replace />;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Admin</h1>
        <Link to="/" className="text-mist text-sm hover:text-cream">descoberta</Link>
      </header>
      {data && data.length > 0 ? (
        <ul className="mt-8 flex flex-col gap-2">
          {data.map((u) => (
            <li key={u.id} className="flex items-center justify-between rounded-xl bg-velvet px-4 py-3">
              <span className="flex flex-col">
                <span className="text-cream">{u.displayName}</span>
                <span className="font-mono text-xs text-mist">{u.email} · {u.role} · {u.status}</span>
              </span>
              {u.status === 'ACTIVE' ? (
                <button type="button" disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ id: u.id, action: 'suspend' })}
                  className="rounded-full border border-mist/40 px-4 py-2 text-sm text-cream hover:border-ember disabled:opacity-50">
                  Suspender
                </button>
              ) : (
                <button type="button" disabled={setStatus.isPending}
                  onClick={() => setStatus.mutate({ id: u.id, action: 'activate' })}
                  className="rounded-full border border-mist/40 px-4 py-2 text-sm text-gold hover:border-gold disabled:opacity-50">
                  Ativar
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-8 text-mist">Nenhum usuário.</p>
      )}
    </main>
  );
}
```

- [ ] **Step 7: Widen `devLogin` in `auth-context.tsx`**

No tipo do contexto e na implementação, trocar `'CLIENT' | 'MODEL'` por `'CLIENT' | 'MODEL' | 'ADMIN'`:
```ts
  devLogin: (role?: 'CLIENT' | 'MODEL' | 'ADMIN') => Promise<void>;
```
```ts
    devLogin: async (role: 'CLIENT' | 'MODEL' | 'ADMIN' = 'CLIENT') => {
      const result = await apiFetch<AuthResult>('/auth/dev-login', { method: 'POST', body: { role } });
      // ...resto idêntico (setSession + setUser)
    },
```
(Manter o corpo existente — só ampliar o tipo do parâmetro.)

- [ ] **Step 8: Add admin dev button in `LoginPage.tsx`**

Dentro do bloco `devEnabled`, após o botão de modelo:
```tsx
            <button
              type="button"
              onClick={() => void devLogin('ADMIN').then(() => navigate('/admin', { replace: true }))}
              className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
            >
              Entrar como admin (dev)
            </button>
```

- [ ] **Step 9: Add route in `App.tsx`**

```tsx
import { AdminPage } from './admin/AdminPage';
// dentro de <Routes>:
<Route path="/admin" element={<ProtectedRoute><AdminPage /></ProtectedRoute>} />
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd web && npx vitest run src/admin/admin.test.tsx`
Expected: PASS (2/2).

- [ ] **Step 11: Whole front suite + build**

Run: `cd web && npx vitest run && npm run build`
Expected: tudo verde; build sem erros.

- [ ] **Step 12: Commit**

```bash
git add web/src/types/api.ts web/src/admin/ web/src/auth/auth-context.tsx web/src/auth/LoginPage.tsx web/src/App.tsx
git commit -m "feat(web): painel admin — listar e ativar/suspender usuários"
```

---

## Notas de verificação final
- `npx tsc --noEmit` limpo; e2e admin (list + activate/suspend + dev-login) verdes.
- Front `npm run build` limpo; suite verde.
- Conferir gate de role: `/admin` redireciona não-admin; dev-login ADMIN só com `DEV_LOGIN=true`.
