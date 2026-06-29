# Painel da Modelo #1 (Presença & Perfil) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modelo loga (dev), edita o perfil e fica online pela UI — aparecendo na descoberta de verdade.

**Architecture:** Backend só estende o `dev-login` pra criar um modelo dev ACTIVE; o resto reusa os endpoints existentes (`me/profile`, `me/heartbeat`). Front ganha auth de modelo, redirect por role e a rota `/painel` (MODEL-only) com formulário de perfil e toggle de presença (heartbeat a cada 20s).

**Tech Stack:** NestJS/Prisma (backend), Jest e2e; React/Vite, TanStack Query, Vitest (front).

## Global Constraints

- `POST /auth/dev-login` mantém a dupla-trava (`DEV_LOGIN==='true'` E `NODE_ENV!=='production'`). Com `{ role: 'MODEL' }` usa/cria um modelo dev (`provider 'dev'`, `subject 'dev-model'`) e garante `status:'ACTIVE'`. Sem role → CLIENT (comportamento atual).
- `/painel` exige sessão E `user.role === 'MODEL'`; não-MODEL → `<Navigate to="/" replace />`.
- Após login: MODEL → `/painel`, CLIENT → `/` (decidido no ponto de chamada do botão).
- Endpoints de perfil/presença usados INALTERADOS: `GET /me/profile` (perfil ou null), `PUT /me/profile` (`{stageName, bio?, pricePerMinute, tags?, voicePreviewUrl?}`), `POST /me/heartbeat`.
- Presença: toggle ligado → `POST /me/heartbeat` imediato + a cada 20s; desligado/desmontado limpa.
- `import type` para tipos/interfaces. Backend `npx tsc --noEmit` limpo. Front: gate real é `npm run build` (tsc -b), não só `tsc --noEmit`.
- Anonimato: `stageName` é o nome público; nunca exibir `displayName` de terceiros.

---

## File Structure

```
src/auth/auth.service.ts        devLogin(role?) + MODEL ACTIVE             [mod]
src/auth/auth.controller.ts     dev-login lê body.role                     [mod]
test/auth.dev-login.e2e-spec.ts + caso MODEL                              [mod]
web/src/types/api.ts            + ModelProfile + UpsertProfileInput        [mod]
web/src/auth/auth-context.tsx   devLogin(role?)                            [mod]
web/src/auth/LoginPage.tsx      + botão "Entrar como modelo (teste)"       [mod]
web/src/model/useProfile.ts                                               [novo]
web/src/model/useUpsertProfile.ts                                        [novo]
web/src/model/usePresence.ts                                             [novo]
web/src/model/ProfileForm.tsx                                            [novo]
web/src/model/PresenceToggle.tsx                                         [novo]
web/src/model/ModelDashboard.tsx                                         [novo]
web/src/App.tsx                 + rota /painel                            [mod]
web/src/model/model.test.tsx                                             [novo]
```

Backend e2e: `npx jest --config ./jest-integration.json --runInBand <file>`. Front: `cd web && npx vitest run <file>`.

---

## Task 1: Backend — dev-login com role MODEL

**Files:**
- Modify: `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`
- Test: `test/auth.dev-login.e2e-spec.ts`

**Interfaces:**
- Consumes: `UsersService.findByProvider/createUser/setStatus(id,'ACTIVE'|'SUSPENDED')`, `TokenService.signAccess/issueRefresh`.
- Produces: `AuthService.devLogin(role?: 'CLIENT' | 'MODEL'): Promise<AuthResult>`; `POST /auth/dev-login` body `{ role?: 'CLIENT' | 'MODEL' }`.

- [ ] **Step 1: Adicionar o caso MODEL ao e2e (falha)**

In `test/auth.dev-login.e2e-spec.ts`, add inside the `describe`:
```ts
  it('com role MODEL cria modelo dev ACTIVE', async () => {
    process.env.DEV_LOGIN = 'true';
    const res = await request(app.getHttpServer()).post('/auth/dev-login').send({ role: 'MODEL' }).expect(201);
    expect(res.body.user.role).toBe('MODEL');
    expect(res.body.user.status).toBe('ACTIVE');
  });

  it('sem role continua CLIENT', async () => {
    process.env.DEV_LOGIN = 'true';
    const res = await request(app.getHttpServer()).post('/auth/dev-login').expect(201);
    expect(res.body.user.role).toBe('CLIENT');
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/auth.dev-login.e2e-spec.ts`
Expected: FAIL — o caso MODEL volta `role==='CLIENT'` (devLogin ignora role).

- [ ] **Step 3: Estender `AuthService.devLogin`**

In `src/auth/auth.service.ts`, replace the existing `devLogin` method with:
```ts
  async devLogin(role: 'CLIENT' | 'MODEL' = 'CLIENT'): Promise<AuthResult> {
    const provider = 'dev';
    const subject = role === 'MODEL' ? 'dev-model' : 'dev-client';
    const email = role === 'MODEL' ? 'dev-model@samy.local' : 'dev@samy.local';
    const name = role === 'MODEL' ? 'Modelo Dev' : 'Cliente Dev';
    let user = await this.users.findByProvider(provider, subject);
    if (!user) {
      user = await this.users.createUser({ role, provider, subject, email, name });
    }
    if (role === 'MODEL' && user.status !== 'ACTIVE') {
      user = await this.users.setStatus(user.id, 'ACTIVE');
    }
    const refreshToken = await this.tokens.issueRefresh(user.id);
    return {
      accessToken: this.tokens.signAccess({ id: user.id, role: user.role }),
      refreshToken,
      user: {
        id: user.id,
        role: user.role,
        status: user.status,
        email: user.email,
        displayName: user.displayName,
      },
    };
  }
```

- [ ] **Step 4: Passar o role no controller**

In `src/auth/auth.controller.ts`, change the `devLogin` route to read the body role:
```ts
  @Post('dev-login')
  async devLogin(@Body() body?: { role?: string }): Promise<unknown> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    return this.auth.devLogin(body?.role === 'MODEL' ? 'MODEL' : 'CLIENT');
  }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/auth.dev-login.e2e-spec.ts`
Expected: PASS (todos — os 3 originais + os 2 novos).

- [ ] **Step 6: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/auth/auth.service.ts src/auth/auth.controller.ts test/auth.dev-login.e2e-spec.ts
git commit -m "feat(auth): dev-login com role MODEL (cria modelo dev ACTIVE)"
```

---

## Task 2: Frontend — auth de modelo (devLogin role + botão + redirect)

**Files:**
- Modify: `web/src/auth/auth-context.tsx`, `web/src/auth/LoginPage.tsx`, `web/src/auth/auth.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`.
- Produces: `useAuth().devLogin(role?: 'CLIENT' | 'MODEL')`; botão "Entrar como modelo (teste)" que navega pra `/painel`.

- [ ] **Step 1: Atualizar o teste do botão dev (falha)**

In `web/src/auth/auth.test.tsx`, in the existing `LoginPage dev-login` describe, add a test (the `sess` fixture, `jsonResponse`, `MemoryRouter`, `AuthProvider`, `LoginPage` imports already exist):
```ts
  it('botão de modelo chama dev-login com role MODEL', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { accessToken: 'a', refreshToken: 'r', user: { ...sess.user, role: 'MODEL' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><AuthProvider><LoginPage /></AuthProvider></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /entrar como modelo/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/auth/dev-login'));
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ role: 'MODEL' });
    });
    vi.unstubAllEnvs();
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/auth/auth.test.tsx`
Expected: FAIL — botão "entrar como modelo" não existe.

- [ ] **Step 3: `devLogin(role)` no auth-context**

In `web/src/auth/auth-context.tsx`:
- Interface: change to `devLogin: (role?: 'CLIENT' | 'MODEL') => Promise<void>;`
- Implementation: replace the `devLogin` in the value object with:
```tsx
    devLogin: async (role: 'CLIENT' | 'MODEL' = 'CLIENT') => {
      const result = await apiFetch<AuthResult>('/auth/dev-login', { method: 'POST', body: { role } });
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user });
      setUser(result.user);
    },
```

- [ ] **Step 4: Botões na LoginPage**

In `web/src/auth/LoginPage.tsx`, replace the single dev button block with two buttons (client + model). The existing dev block is:
```tsx
        {devEnabled && (
          <button
            type="button"
            onClick={() => void devLogin().then(() => navigate('/', { replace: true }))}
            className="mt-4 rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
          >
            Entrar como teste (dev)
          </button>
        )}
```
Replace with:
```tsx
        {devEnabled && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => void devLogin('CLIENT').then(() => navigate('/', { replace: true }))}
              className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
            >
              Entrar como cliente (dev)
            </button>
            <button
              type="button"
              onClick={() => void devLogin('MODEL').then(() => navigate('/painel', { replace: true }))}
              className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
            >
              Entrar como modelo (teste)
            </button>
          </div>
        )}
```
(The existing `auth.test.tsx` test for the dev button matches `/entrar como teste/i`; update that test's matcher to `/entrar como cliente/i`.)

- [ ] **Step 5: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/auth/auth.test.tsx`
Expected: PASS (incl. o caso de modelo e o de cliente atualizado).

- [ ] **Step 6: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/auth
git commit -m "feat(web): auth de modelo (devLogin role) + botões cliente/modelo na LoginPage"
```

---

## Task 3: Frontend — `/painel` (perfil + presença)

**Files:**
- Modify: `web/src/types/api.ts`, `web/src/App.tsx`
- Create: `web/src/model/useProfile.ts`, `useUpsertProfile.ts`, `usePresence.ts`, `ProfileForm.tsx`, `PresenceToggle.tsx`, `ModelDashboard.tsx`, `model.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`; `useAuth` (role-gate); endpoints `me/profile`, `me/heartbeat`.
- Produces: `<ModelDashboard>` na rota `/painel`; `useProfile()`, `useUpsertProfile()`, `usePresence()`; tipos `ModelProfile`, `UpsertProfileInput`.

- [ ] **Step 1: Tipos**

In `web/src/types/api.ts`, add:
```ts
export interface ModelProfile {
  userId: string;
  stageName: string;
  bio: string | null;
  pricePerMinute: string;
  tags: string[];
  voicePreviewUrl: string | null;
}

export interface UpsertProfileInput {
  stageName: string;
  bio?: string;
  pricePerMinute: string;
  tags?: string[];
  voicePreviewUrl?: string;
}
```

- [ ] **Step 2: Escrever os testes (falham)**

Create `web/src/model/model.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelDashboard } from './ModelDashboard';
import { AuthProvider } from '../auth/auth-context';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

function sess(role: 'CLIENT' | 'MODEL'): Session {
  return { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role, status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(initial = '/painel'): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>vitrine</div>} />
            <Route path="/painel" element={<ModelDashboard />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('ModelDashboard', () => {
  it('carrega o perfil no formulário e salvar chama PUT /me/profile', async () => {
    setSession(sess('MODEL'));
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/me/profile') && (!init || init.method === undefined || init.method === 'GET')) {
        return Promise.resolve(json(200, { userId: 'u1', stageName: 'Lara', bio: null, pricePerMinute: '5.00', tags: ['suave'], voicePreviewUrl: null }));
      }
      if (u.endsWith('/me/profile') && init?.method === 'PUT') return Promise.resolve(json(200, {}));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await waitFor(() => expect((screen.getByLabelText(/nome art/i) as HTMLInputElement).value).toBe('Lara'));
    await userEvent.click(screen.getByRole('button', { name: /salvar/i }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/me/profile') && (c[1] as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body)).stageName).toBe('Lara');
    });
  });

  it('toggle de presença liga e chama POST /me/heartbeat', async () => {
    setSession(sess('MODEL'));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith('/me/profile')) return Promise.resolve(json(200, null));
      if (u.endsWith('/me/heartbeat')) return Promise.resolve(json(200, { status: 'ONLINE', ttl: 30 }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await userEvent.click(await screen.findByRole('button', { name: /ficar online/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/me/heartbeat'))).toBe(true));
  });

  it('CLIENT em /painel é redirecionado pra vitrine', async () => {
    setSession(sess('CLIENT'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, null)));
    render(wrap());
    await waitFor(() => expect(screen.getByText('vitrine')).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/model/model.test.tsx`
Expected: FAIL — módulos do model não existem.

- [ ] **Step 4: Hooks**

Create `web/src/model/useProfile.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ModelProfile } from '../types/api';

export function useProfile(): ReturnType<typeof useQuery<ModelProfile | null>> {
  return useQuery<ModelProfile | null>({
    queryKey: ['my-profile'],
    queryFn: () => apiFetch<ModelProfile | null>('/me/profile', { auth: true }),
  });
}
```

Create `web/src/model/useUpsertProfile.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { UpsertProfileInput } from '../types/api';

export function useUpsertProfile(): ReturnType<typeof useMutation<unknown, Error, UpsertProfileInput>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, UpsertProfileInput>({
    mutationFn: (dto: UpsertProfileInput) => apiFetch('/me/profile', { method: 'PUT', body: dto, auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['my-profile'] }); },
  });
}
```

Create `web/src/model/usePresence.ts`:
```ts
import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api-client';

const HEARTBEAT_MS = 20000;

export function usePresence(): { online: boolean; toggle: () => void } {
  const [online, setOnline] = useState(false);
  useEffect(() => {
    if (!online) return;
    const beat = (): void => { void apiFetch('/me/heartbeat', { method: 'POST', auth: true }).catch(() => {}); };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [online]);
  return { online, toggle: () => setOnline((v) => !v) };
}
```

- [ ] **Step 5: PresenceToggle**

Create `web/src/model/PresenceToggle.tsx`:
```tsx
import { usePresence } from './usePresence';

export function PresenceToggle(): JSX.Element {
  const { online, toggle } = usePresence();
  return (
    <div className="rounded-2xl bg-velvet p-6 flex items-center justify-between">
      <div>
        <p className="font-display text-2xl text-cream">{online ? 'Online' : 'Offline'}</p>
        <p className="text-mist text-sm">{online ? 'Você está visível na descoberta.' : 'Ligue para aparecer para os clientes.'}</p>
      </div>
      <button
        type="button"
        aria-pressed={online}
        onClick={toggle}
        className={`rounded-full px-6 py-3 ${online ? 'bg-gold text-void' : 'border border-mist/40 text-cream hover:border-ember'}`}
      >
        {online ? 'Ficar offline' : 'Ficar online'}
      </button>
    </div>
  );
}
```

- [ ] **Step 6: ProfileForm**

Create `web/src/model/ProfileForm.tsx`:
```tsx
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useProfile } from './useProfile';
import { useUpsertProfile } from './useUpsertProfile';

export function ProfileForm(): JSX.Element {
  const { data, isLoading } = useProfile();
  const upsert = useUpsertProfile();
  const [stageName, setStageName] = useState('');
  const [bio, setBio] = useState('');
  const [price, setPrice] = useState('5.00');
  const [tags, setTags] = useState('');
  const [voice, setVoice] = useState('');

  useEffect(() => {
    if (data) {
      setStageName(data.stageName);
      setBio(data.bio ?? '');
      setPrice(data.pricePerMinute);
      setTags(data.tags.join(', '));
      setVoice(data.voicePreviewUrl ?? '');
    }
  }, [data]);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    upsert.mutate({
      stageName,
      bio: bio || undefined,
      pricePerMinute: price,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      voicePreviewUrl: voice || undefined,
    });
  };

  if (isLoading) return <div className="mt-6 h-64 rounded-2xl bg-velvet animate-pulse" />;

  return (
    <form onSubmit={submit} className="mt-6 rounded-2xl bg-velvet p-6 flex flex-col gap-4">
      <div>
        <label htmlFor="stageName" className="block text-mist text-sm">Nome artístico</label>
        <input id="stageName" value={stageName} onChange={(e) => setStageName(e.target.value)} required className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="bio" className="block text-mist text-sm">Bio</label>
        <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} rows={3} className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="price" className="block text-mist text-sm">Preço por minuto (créditos)</label>
        <input id="price" type="number" min="1" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required className="mt-1 w-full rounded-lg bg-void px-4 py-3 font-mono text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="tags" className="block text-mist text-sm">Tags (separadas por vírgula)</label>
        <input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="suave, grave, carinhosa" className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <div>
        <label htmlFor="voice" className="block text-mist text-sm">URL do preview de voz (opcional)</label>
        <input id="voice" value={voice} onChange={(e) => setVoice(e.target.value)} className="mt-1 w-full rounded-lg bg-void px-4 py-3 text-cream outline-none focus-visible:ring-2 focus-visible:ring-ember" />
      </div>
      <button type="submit" disabled={upsert.isPending} className="rounded-full bg-ember px-6 py-3 text-void disabled:opacity-50">
        {upsert.isPending ? 'Salvando…' : 'Salvar perfil'}
      </button>
      {upsert.isSuccess && <p className="text-gold text-sm">Perfil salvo ✓</p>}
      {upsert.isError && <p className="text-ember text-sm">Não foi possível salvar. Tente de novo.</p>}
    </form>
  );
}
```

- [ ] **Step 7: ModelDashboard**

Create `web/src/model/ModelDashboard.tsx`:
```tsx
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { PresenceToggle } from './PresenceToggle';
import { ProfileForm } from './ProfileForm';

export function ModelDashboard(): JSX.Element {
  const { user, logout } = useAuth();
  if (user?.role !== 'MODEL') return <Navigate to="/" replace />;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Seu painel</h1>
        <button onClick={() => void logout()} className="text-mist text-sm hover:text-cream">sair</button>
      </header>
      <div className="mt-8"><PresenceToggle /></div>
      <ProfileForm />
    </main>
  );
}
```

- [ ] **Step 8: Rota /painel**

In `web/src/App.tsx`, import `ModelDashboard` and add the protected route:
```tsx
import { ModelDashboard } from './model/ModelDashboard';
```
Add inside `<Routes>`:
```tsx
      <Route path="/painel" element={<ProtectedRoute><ModelDashboard /></ProtectedRoute>} />
```

- [ ] **Step 9: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/model/model.test.tsx`
Expected: PASS (3/3). Depois `npx vitest run` (suíte inteira) verde.

- [ ] **Step 10: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/types/api.ts web/src/model web/src/App.tsx
git commit -m "feat(web): painel da modelo /painel — perfil + toggle de presença"
```

---

## Task 4: Verificação final + push

- [ ] **Step 1: Suíte backend completa**

Run: `npm run test:int`
Expected: tudo verde (incl. auth.dev-login com o caso MODEL).

- [ ] **Step 2: Front — suíte + build**

Run (in `web/`): `npx vitest run` e `npm run build`
Expected: tudo verde; build limpo.

- [ ] **Step 3: Verificação manual (stack no ar)**

`web/.env` com `VITE_DEV_LOGIN="true"`, `.env` (raiz) com `DEV_LOGIN=true`. Login → "Entrar como
modelo (teste)" → `/painel` → preencher e salvar perfil → ligar "Ficar online" → noutra aba, login
como cliente → ver a modelo ONLINE na descoberta (voiceprint pulsando).

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review (autor)

**Cobertura do spec:**
- §3/§4.1 dev-login role MODEL ACTIVE → Task 1 (+e2e MODEL/CLIENT). ✓
- §4.2 devLogin(role) + botão modelo + redirect por role → Task 2. ✓
- §4.3 /painel role-gate + header → Task 3 (ModelDashboard). ✓
- §4.3 ProfileForm (GET/PUT, tags texto↔array) → Task 3. ✓
- §4.3 PresenceToggle (heartbeat imediato + 20s, cleanup) → Task 3 (usePresence). ✓
- §4.4 hooks useProfile/useUpsertProfile/usePresence → Task 3. ✓
- §4.5 tipos ModelProfile/UpsertProfileInput → Task 3 Step 1. ✓
- §6 testes (backend MODEL; front load/save/toggle/redirect) → Tasks 1/3. ✓
- §7 verificação manual → Task 4. ✓

**Consistência de tipos:** `devLogin(role?: 'CLIENT'|'MODEL')` igual em back/front; `ModelProfile`/`UpsertProfileInput` casam com `UpsertProfileDto` do backend; `usePresence()→{online,toggle}`; rota `/painel`. AuthResult shape reusado.

**Placeholders:** nenhum — código/comando concreto em cada passo. Task 2 Step 4 nota a atualização do matcher do teste existente (`/entrar como teste/i`→`/entrar como cliente/i`) — edição concreta sobre teste existente.

**Nota:** gate de tipos do front é `npm run build` (tsc -b), usado nos commits das tasks de front.
