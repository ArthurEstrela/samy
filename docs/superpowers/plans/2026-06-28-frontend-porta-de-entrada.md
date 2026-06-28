# Frontend — Fundação + Porta de Entrada Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o app web (Vite/React/TS) com login Google, descoberta de modelos e perfil — consumindo a API NestJS existente, no estilo "candlelit after-midnight" com voiceprint vivo.

**Architecture:** SPA em `web/`. Client de API tipado com refresh-no-401. Sessão em localStorage via AuthProvider. React Router (rotas protegidas). TanStack Query pra estado de servidor. Tailwind v4 com tokens de design. Vitest + Testing Library mockando o boundary de API.

**Tech Stack:** Vite, React 18, TypeScript, react-router-dom v7, @tanstack/react-query v5, Tailwind CSS v4 (@tailwindcss/vite), Vitest + @testing-library/react, fontsource (Fraunces/Hanken Grotesk/Space Mono).

## Global Constraints

- **Anonimato:** a UI nunca exibe `displayName` de modelos — só `stageName`. (O `user` da própria sessão pode ter displayName; nunca renderizar o de terceiros.)
- **Sessão:** `{accessToken, refreshToken, user}` de `/auth/google`. No `401`: `POST /auth/refresh {refreshToken}` UMA vez (rotação: salvar o novo refresh), retentar a request original UMA vez; se o refresh falhar, limpar sessão e sinalizar não-autenticado (router → `/login`). Sem loop.
- **Toda rota autenticada exige sessão**; sem ela → `/login`.
- **Builda/testa sem credencial:** testes mockam o boundary de API (sem Google/backend real). Login ao vivo exige `VITE_GOOGLE_CLIENT_ID`.
- **TypeScript estrito; `tsc --noEmit` limpo.** Nenhum segredo commitado (`web/.env` gitignored; `web/.env.example` documenta).
- **Design tokens (Tailwind):** `void #0E0A10`, `velvet #1A121F`, `ember #E76F61`, `gold #C9A36B`, `cream #F2E9E4`, `mist #9C8AA0`. Fontes: display Fraunces, corpo Hanken Grotesk, mono Space Mono (preço/min). Status: ONLINE glow gold/ember, OCUPADA rosa âmbar dim, OFFLINE malva frio.
- **Voiceprint vivo** só anima quando ONLINE; respeitar `prefers-reduced-motion`. Avatar = orb de gradiente derivado do id (sem rostos).
- **Não tocar no backend.**

---

## Tipos da API (referência — usados em várias tasks)

```ts
export type CallStatus = 'ONLINE' | 'OCUPADA' | 'OFFLINE';
export interface ModelCard {
  userId: string;
  stageName: string;
  bio: string | null;
  pricePerMinute: string;
  tags: string[];
  voicePreviewUrl: string | null;
  status: CallStatus;
  isFavorite: boolean;
}
export interface SessionUser { id: string; role: string; status: string; email: string; displayName: string; }
export interface AuthResult { accessToken: string; refreshToken: string; user: SessionUser; }
export interface RefreshResult { accessToken: string; refreshToken: string; }
```

Endpoints consumidos: `POST /auth/google {idToken, role}` → `AuthResult`; `POST /auth/refresh {refreshToken}` → `RefreshResult`; `POST /auth/logout {refreshToken}` → `{ok}`; `GET /models?tags=&limit=&offset=` → `ModelCard[]`; `GET /models/:id` → `ModelCard`; `POST /favorites/:modelId` → `{ok:true}`; `DELETE /favorites/:modelId` → `{ok:true}`.

---

## File Structure

```
web/
  index.html                         + script GIS, root div
  package.json, vite.config.ts, tsconfig*.json
  .env.example                       VITE_API_URL, VITE_GOOGLE_CLIENT_ID
  src/
    main.tsx                         providers + render
    App.tsx                          rotas
    index.css                        @import tailwind + @theme tokens + base
    vite-env.d.ts                    tipos env + window.google (GIS)
    test/setup.ts                    jest-dom
    types/api.ts                     tipos acima
    lib/session.ts                   get/set/clear sessão (localStorage)
    lib/api-client.ts                apiFetch + refresh-no-401
    lib/hue.ts                       hueFromId (orb determinístico)
    auth/auth-context.tsx            AuthProvider + useAuth
    auth/ProtectedRoute.tsx
    auth/LoginPage.tsx
    ui/StatusBadge.tsx
    ui/Voiceprint.tsx
    ui/Orb.tsx
    discovery/useModels.ts
    discovery/ModelCard.tsx
    discovery/DiscoveryPage.tsx
    profile/useModel.ts
    profile/useFavorite.ts
    profile/ModelProfilePage.tsx
  README.md
```

Trabalhe sempre de `web/` (todos os comandos `npm ...` rodam lá). Testes: `npm test -- run` (Vitest single-run) ou `npx vitest run <arquivo>`.

---

## Task 1: Scaffold (Vite + Tailwind + Router + Query + Vitest)

**Files:** cria a base toda em `web/`.

**Interfaces:**
- Produces: app que builda e testa; tokens Tailwind (`bg-void`, `text-ember`, `font-display`, etc.); `QueryClientProvider` + `BrowserRouter` montados.

- [ ] **Step 1: Scaffold Vite**

From the repo root, run:
```
npm create vite@latest web -- --template react-ts
```
Then:
```
cd web && npm install
```

- [ ] **Step 2: Instalar dependências**

Primeiro, **fixar React 18** (o template do Vite pode vir com React 19, onde o namespace global `JSX` foi removido e os `: JSX.Element` deste plano não compilam). Em `web/`:
```
npm i react@^18 react-dom@^18
npm i -D @types/react@^18 @types/react-dom@^18
```
Depois as demais:
```
npm i react-router-dom @tanstack/react-query @fontsource-variable/fraunces @fontsource-variable/hanken-grotesk @fontsource/space-mono
npm i -D tailwindcss @tailwindcss/vite vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```
(Se ainda assim o `tsc` reclamar do namespace `JSX`, confirme que `@types/react` é 18.x em `package.json` e rode `npm install` de novo.)

- [ ] **Step 3: vite.config.ts (plugins + vitest)**

Replace `web/vite.config.ts` with:
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
```

- [ ] **Step 4: Tokens de design (index.css)**

Replace `web/src/index.css` with:
```css
@import "tailwindcss";

@theme {
  --color-void: #0E0A10;
  --color-velvet: #1A121F;
  --color-ember: #E76F61;
  --color-gold: #C9A36B;
  --color-cream: #F2E9E4;
  --color-mist: #9C8AA0;
  --font-display: "Fraunces Variable", serif;
  --font-body: "Hanken Grotesk Variable", sans-serif;
  --font-mono: "Space Mono", monospace;
}

body {
  margin: 0;
  background: var(--color-void);
  color: var(--color-cream);
  font-family: var(--font-body);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 5: Env types + GIS global (vite-env.d.ts)**

Replace `web/src/vite-env.d.ts` with:
```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }

interface Window {
  google?: {
    accounts: {
      id: {
        initialize: (config: { client_id: string; callback: (resp: { credential: string }) => void }) => void;
        renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
      };
    };
  };
}
```

- [ ] **Step 6: Test setup + smoke test**

Create `web/src/test/setup.ts`:
```ts
import '@testing-library/jest-dom';
```

Replace `web/src/App.tsx` with a placeholder:
```tsx
export default function App(): JSX.Element {
  return <div className="font-display text-ember">Samy</div>;
}
```

Create `web/src/App.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import App from './App';

it('renderiza o nome do produto', () => {
  render(<App />);
  expect(screen.getByText('Samy')).toBeInTheDocument();
});
```

- [ ] **Step 7: Providers (main.tsx)**

Replace `web/src/main.tsx` with:
```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/fraunces';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource/space-mono';
import './index.css';
import App from './App';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 8: Carregar o script do Google Identity Services**

In `web/index.html`, add inside `<head>`:
```html
    <script src="https://accounts.google.com/gsi/client" async></script>
```

- [ ] **Step 9: Verificar build/test/tsc**

Run (in `web/`):
```
npx tsc --noEmit
npx vitest run
npm run build
```
Expected: tsc limpo; 1 teste passa; build conclui.

- [ ] **Step 10: Commit**

```bash
git add web
git commit -m "feat(web): scaffold Vite/React/TS + Tailwind tokens + Router/Query/Vitest"
```

---

## Task 2: Tipos + sessão + client de API (refresh-no-401)

**Files:**
- Create: `web/src/types/api.ts`, `web/src/lib/session.ts`, `web/src/lib/api-client.ts`
- Test: `web/src/lib/api-client.test.ts`

**Interfaces:**
- Consumes: tipos da API (acima).
- Produces:
  - `getSession(): Session | null`, `setSession(s: Session): void`, `clearSession(): void`; `Session = { accessToken: string; refreshToken: string; user: SessionUser }`.
  - `apiFetch<T>(path: string, opts?: { method?: string; body?: unknown; auth?: boolean }): Promise<T>` — injeta Bearer, refresh-no-401; lança `ApiError { status: number; message: string }`; em falha de auth lança `ApiError` com `status: 401`.

- [ ] **Step 1: Tipos da API**

Create `web/src/types/api.ts`:
```ts
export type CallStatus = 'ONLINE' | 'OCUPADA' | 'OFFLINE';

export interface ModelCard {
  userId: string;
  stageName: string;
  bio: string | null;
  pricePerMinute: string;
  tags: string[];
  voicePreviewUrl: string | null;
  status: CallStatus;
  isFavorite: boolean;
}

export interface SessionUser {
  id: string;
  role: string;
  status: string;
  email: string;
  displayName: string;
}

export interface AuthResult { accessToken: string; refreshToken: string; user: SessionUser; }
export interface RefreshResult { accessToken: string; refreshToken: string; }
```

- [ ] **Step 2: Sessão**

Create `web/src/lib/session.ts`:
```ts
import type { SessionUser } from '../types/api';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

const KEY = 'samy.session';

export function getSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(s: Session): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
}
```

- [ ] **Step 3: Escrever os testes do client (falham)**

Create `web/src/lib/api-client.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, ApiError } from './api-client';
import { getSession, setSession, clearSession } from './session';
import type { Session } from './session';

const sess: Session = {
  accessToken: 'acc1',
  refreshToken: 'ref1',
  user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('apiFetch', () => {
  it('injeta Authorization quando há sessão', async () => {
    setSession(sess);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, [{ userId: 'm1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const out = await apiFetch<{ userId: string }[]>('/models', { auth: true });
    expect(out[0].userId).toBe('m1');
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer acc1');
  });

  it('no 401 faz refresh (rotação), persiste novos tokens e retenta uma vez', async () => {
    setSession(sess);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: 'expired' }))            // request original
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'acc2', refreshToken: 'ref2' })) // refresh
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));                     // retry
    vi.stubGlobal('fetch', fetchMock);
    const out = await apiFetch<{ ok: boolean }>('/models', { auth: true });
    expect(out.ok).toBe(true);
    expect(getSession()?.accessToken).toBe('acc2');
    expect(getSession()?.refreshToken).toBe('ref2');
    // o retry usa o novo token
    const retryHeaders = (fetchMock.mock.calls[2][1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer acc2');
  });

  it('se o refresh falhar, limpa a sessão e lança ApiError 401', async () => {
    setSession(sess);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: 'expired' }))  // original
      .mockResolvedValueOnce(jsonResponse(401, { message: 'bad refresh' })); // refresh falha
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/models', { auth: true })).rejects.toMatchObject({ status: 401 });
    expect(getSession()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2); // não entra em loop
  });

  it('propaga ApiError em erro não-401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiFetch('/models')).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/lib/api-client.test.ts`
Expected: FAIL — `api-client` não existe.

- [ ] **Step 5: Implementar o client**

Create `web/src/lib/api-client.ts`:
```ts
import { getSession, setSession, clearSession } from './session';
import type { RefreshResult } from '../types/api';

const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Options {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function raw(path: string, opts: Options, accessToken?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (data && typeof data === 'object' && 'message' in data)
      ? String((data as { message: unknown }).message)
      : res.statusText;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

async function tryRefresh(): Promise<string | null> {
  const session = getSession();
  if (!session) return null;
  const res = await raw('/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken } });
  if (!res.ok) {
    clearSession();
    return null;
  }
  const rotated = (await res.json()) as RefreshResult;
  setSession({ ...session, accessToken: rotated.accessToken, refreshToken: rotated.refreshToken });
  return rotated.accessToken;
}

export async function apiFetch<T>(path: string, opts: Options = {}): Promise<T> {
  const useAuth = opts.auth ?? false;
  const token = useAuth ? getSession()?.accessToken : undefined;
  const res = await raw(path, opts, token);
  if (res.status === 401 && useAuth) {
    const newToken = await tryRefresh();
    if (!newToken) {
      throw new ApiError(401, 'not authenticated');
    }
    const retry = await raw(path, opts, newToken);
    return parse<T>(retry);
  }
  return parse<T>(res);
}
```

- [ ] **Step 6: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/lib/api-client.test.ts`
Expected: PASS (4/4).

- [ ] **Step 7: tsc + commit**

Run (in `web/`): `npx tsc --noEmit` → limpo.
```bash
git add web/src/types web/src/lib
git commit -m "feat(web): tipos da API + sessão + client com refresh-no-401"
```

---

## Task 3: Auth (AuthProvider + ProtectedRoute + LoginPage + rotas)

**Files:**
- Create: `web/src/auth/auth-context.tsx`, `web/src/auth/ProtectedRoute.tsx`, `web/src/auth/LoginPage.tsx`
- Modify: `web/src/App.tsx`, `web/src/main.tsx` (envolver com AuthProvider)
- Test: `web/src/auth/auth.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, sessão, tipos.
- Produces:
  - `useAuth(): { user: SessionUser | null; login: (idToken: string) => Promise<void>; logout: () => Promise<void> }`.
  - `<AuthProvider>` (envolve o app), `<ProtectedRoute>` (children-gate), `<LoginPage>`.

- [ ] **Step 1: Escrever os testes (falham)**

Create `web/src/auth/auth.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth-context';
import { ProtectedRoute } from './ProtectedRoute';
import { getSession, setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = {
  accessToken: 'a', refreshToken: 'r',
  user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' },
};
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

function LoginProbe(): JSX.Element {
  const { user, login, logout } = useAuth();
  return (
    <div>
      <span>user:{user ? user.id : 'none'}</span>
      <button onClick={() => void login('idtok')}>login</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

describe('AuthProvider', () => {
  it('login persiste sessão e popula user; logout limpa', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'a', refreshToken: 'r', user: sess.user })) // /auth/google
      .mockResolvedValueOnce(jsonResponse(200, { ok: true })); // /auth/logout
    vi.stubGlobal('fetch', fetchMock);
    render(<AuthProvider><LoginProbe /></AuthProvider>);
    expect(screen.getByText('user:none')).toBeInTheDocument();
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByText('user:u1')).toBeInTheDocument());
    expect(getSession()?.user.id).toBe('u1');
    await userEvent.click(screen.getByText('logout'));
    await waitFor(() => expect(screen.getByText('user:none')).toBeInTheDocument());
    expect(getSession()).toBeNull();
  });
});

describe('ProtectedRoute', () => {
  it('sem sessão redireciona pra /login', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>tela de login</div>} />
            <Route path="/" element={<ProtectedRoute><div>protegido</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('tela de login')).toBeInTheDocument();
  });

  it('com sessão renderiza o filho', () => {
    setSession(sess);
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<div>tela de login</div>} />
            <Route path="/" element={<ProtectedRoute><div>protegido</div></ProtectedRoute>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('protegido')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/auth/auth.test.tsx`
Expected: FAIL — módulos de auth não existem.

- [ ] **Step 3: AuthProvider**

Create `web/src/auth/auth-context.tsx`:
```tsx
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch } from '../lib/api-client';
import { getSession, setSession, clearSession } from '../lib/session';
import type { AuthResult, SessionUser } from '../types/api';

interface AuthValue {
  user: SessionUser | null;
  login: (idToken: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<SessionUser | null>(() => getSession()?.user ?? null);

  const value = useMemo<AuthValue>(() => ({
    user,
    login: async (idToken: string) => {
      const result = await apiFetch<AuthResult>('/auth/google', {
        method: 'POST',
        body: { idToken, role: 'CLIENT' },
      });
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user });
      setUser(result.user);
    },
    logout: async () => {
      const session = getSession();
      if (session) {
        try {
          await apiFetch('/auth/logout', { method: 'POST', body: { refreshToken: session.refreshToken } });
        } catch {
          // logout é best-effort; limpa local de qualquer forma
        }
      }
      clearSession();
      setUser(null);
    },
  }), [user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
```

- [ ] **Step 4: ProtectedRoute**

Create `web/src/auth/ProtectedRoute.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from './auth-context';

export function ProtectedRoute({ children }: { children: ReactNode }): JSX.Element {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 5: LoginPage**

Create `web/src/auth/LoginPage.tsx`:
```tsx
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './auth-context';

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const btnRef = useRef<HTMLDivElement>(null);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

  useEffect(() => {
    if (!clientId || !window.google || !btnRef.current) return;
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (resp) => {
        void login(resp.credential).then(() => navigate('/', { replace: true }));
      },
    });
    window.google.accounts.id.renderButton(btnRef.current, { theme: 'filled_black', size: 'large', shape: 'pill' });
  }, [clientId, login, navigate]);

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="text-center max-w-sm">
        <h1 className="font-display text-5xl text-cream">Samy</h1>
        <p className="mt-3 text-mist">Quem você quer ouvir esta noite?</p>
        <div className="mt-8 flex justify-center">
          {clientId
            ? <div ref={btnRef} />
            : <p className="text-mist text-sm">Login não configurado (defina <code>VITE_GOOGLE_CLIENT_ID</code>).</p>}
        </div>
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Rotas (App.tsx) + AuthProvider (main.tsx)**

Replace `web/src/App.tsx` with:
```tsx
import { Routes, Route } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { DiscoveryPage } from './discovery/DiscoveryPage';
import { ModelProfilePage } from './profile/ModelProfilePage';

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<ProtectedRoute><DiscoveryPage /></ProtectedRoute>} />
      <Route path="/models/:id" element={<ProtectedRoute><ModelProfilePage /></ProtectedRoute>} />
    </Routes>
  );
}
```

> Nota: `DiscoveryPage` e `ModelProfilePage` são criados nas Tasks 4 e 5. Até lá, o `App.test.tsx` do scaffold falha ao importar — então neste passo crie stubs mínimos pra manter verde, que serão substituídos:
> `web/src/discovery/DiscoveryPage.tsx`: `export function DiscoveryPage(): JSX.Element { return <div>discovery</div>; }`
> `web/src/profile/ModelProfilePage.tsx`: `export function ModelProfilePage(): JSX.Element { return <div>profile</div>; }`
> Também **remova** `web/src/App.test.tsx` do scaffold (o "Samy" agora vive na LoginPage, não no App) — a cobertura de App vem via os testes de rota/auth.

In `web/src/main.tsx`, wrap `<App />` with `<AuthProvider>`. Add the import `import { AuthProvider } from './auth/auth-context';` and change the tree to:
```tsx
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
```

- [ ] **Step 7: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/auth/auth.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 8: tsc + commit**

Run (in `web/`): `npx tsc --noEmit` → limpo.
```bash
git add web/src
git commit -m "feat(web): AuthProvider + ProtectedRoute + LoginPage (GIS) + rotas"
```

---

## Task 4: Descoberta (orb + voiceprint + card + lista)

**Files:**
- Create: `web/src/lib/hue.ts`, `web/src/ui/StatusBadge.tsx`, `web/src/ui/Orb.tsx`, `web/src/ui/Voiceprint.tsx`, `web/src/discovery/useModels.ts`, `web/src/discovery/ModelCard.tsx`, `web/src/discovery/DiscoveryPage.tsx`
- Test: `web/src/discovery/discovery.test.tsx`, `web/src/ui/StatusBadge.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ModelCard` type, `useAuth`.
- Produces: `useModels()` (TanStack Query → `ModelCard[]`); `<DiscoveryPage>`; `<ModelCard>`; `<StatusBadge status>`; `<Voiceprint seed alive>`; `<Orb seed>`; `hueFromId(id): number`.

- [ ] **Step 1: Escrever os testes (falham)**

Create `web/src/ui/StatusBadge.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './StatusBadge';

it('mapeia cada status pro rótulo certo', () => {
  const { rerender } = render(<StatusBadge status="ONLINE" />);
  expect(screen.getByText('online')).toBeInTheDocument();
  rerender(<StatusBadge status="OCUPADA" />);
  expect(screen.getByText('ocupada')).toBeInTheDocument();
  rerender(<StatusBadge status="OFFLINE" />);
  expect(screen.getByText('offline')).toBeInTheDocument();
});
```

Create `web/src/discovery/discovery.test.tsx`:
```tsx
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DiscoveryPage } from './DiscoveryPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';
import type { ModelCard } from '../types/api';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
const cards: ModelCard[] = [
  { userId: 'm1', stageName: 'Lara', bio: null, pricePerMinute: '4.00', tags: ['suave'], voicePreviewUrl: null, status: 'ONLINE', isFavorite: false },
  { userId: 'm2', stageName: 'Bia', bio: null, pricePerMinute: '6.00', tags: [], voicePreviewUrl: null, status: 'OFFLINE', isFavorite: false },
];
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

it('renderiza os cards da lista (stageName, nunca nome real)', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, cards)));
  render(wrap(<DiscoveryPage />));
  await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
  expect(screen.getByText('Bia')).toBeInTheDocument();
  expect(screen.queryByText('A')).not.toBeInTheDocument();
});

it('mostra estado vazio quando não há modelos', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, [])));
  render(wrap(<DiscoveryPage />));
  await waitFor(() => expect(screen.getByText(/nenhuma voz/i)).toBeInTheDocument());
});

it('mostra estado de erro quando a API falha', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' })));
  render(wrap(<DiscoveryPage />));
  await waitFor(() => expect(screen.getByText(/tentar de novo/i)).toBeInTheDocument());
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/discovery/discovery.test.tsx src/ui/StatusBadge.test.tsx`
Expected: FAIL — componentes não existem.

- [ ] **Step 3: hueFromId**

Create `web/src/lib/hue.ts`:
```ts
// Hue determinístico (0..359) a partir do id — orb/voiceprint únicos e estáveis por modelo.
export function hueFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  return h;
}
```

- [ ] **Step 4: StatusBadge**

Create `web/src/ui/StatusBadge.tsx`:
```tsx
import type { CallStatus } from '../types/api';

const LABEL: Record<CallStatus, string> = { ONLINE: 'online', OCUPADA: 'ocupada', OFFLINE: 'offline' };
const STYLE: Record<CallStatus, string> = {
  ONLINE: 'text-gold',
  OCUPADA: 'text-ember/80',
  OFFLINE: 'text-mist',
};

export function StatusBadge({ status }: { status: CallStatus }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs uppercase tracking-wide ${STYLE[status]}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${status === 'ONLINE' ? 'bg-gold' : status === 'OCUPADA' ? 'bg-ember/80' : 'bg-mist'}`} />
      {LABEL[status]}
    </span>
  );
}
```

- [ ] **Step 5: Orb**

Create `web/src/ui/Orb.tsx`:
```tsx
import { hueFromId } from '../lib/hue';

export function Orb({ seed, size = 56 }: { seed: string; size?: number }): JSX.Element {
  const hue = hueFromId(seed);
  const style = {
    width: size,
    height: size,
    background: `radial-gradient(circle at 30% 30%, hsl(${hue} 70% 62%), hsl(${(hue + 40) % 360} 55% 28%))`,
  };
  return <div aria-hidden className="rounded-full shrink-0" style={style} />;
}
```

- [ ] **Step 6: Voiceprint (assinatura — pulsa se online)**

Create `web/src/ui/Voiceprint.tsx`:
```tsx
import { hueFromId } from '../lib/hue';

const BAR_COUNT = 28;

export function Voiceprint({ seed, alive }: { seed: string; alive: boolean }): JSX.Element {
  const hue = hueFromId(seed);
  // alturas determinísticas a partir do seed
  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    const n = (hueFromId(`${seed}:${i}`) % 70) + 20; // 20..89
    return n;
  });
  return (
    <div
      className="flex items-end gap-[2px] h-8"
      role="img"
      aria-label={alive ? 'voz ao vivo' : 'voz offline'}
    >
      {bars.map((h, i) => (
        <span
          key={i}
          className={alive ? 'voiceprint-bar voiceprint-bar--alive' : 'voiceprint-bar'}
          style={{
            height: `${h}%`,
            width: 3,
            background: alive ? `hsl(${hue} 70% 60%)` : 'var(--color-mist)',
            opacity: alive ? 1 : 0.5,
            animationDelay: `${i * 60}ms`,
          }}
        />
      ))}
    </div>
  );
}
```

Append to `web/src/index.css`:
```css
.voiceprint-bar { border-radius: 2px; transform-origin: bottom; }
.voiceprint-bar--alive { animation: breathe 1.6s ease-in-out infinite; }
@keyframes breathe {
  0%, 100% { transform: scaleY(0.5); }
  50% { transform: scaleY(1); }
}
```

- [ ] **Step 7: useModels**

Create `web/src/discovery/useModels.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ModelCard } from '../types/api';

export function useModels(): ReturnType<typeof useQuery<ModelCard[]>> {
  return useQuery<ModelCard[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch<ModelCard[]>('/models', { auth: true }),
  });
}
```

- [ ] **Step 8: ModelCard**

Create `web/src/discovery/ModelCard.tsx`:
```tsx
import { Link } from 'react-router-dom';
import type { ModelCard as ModelCardType } from '../types/api';
import { Orb } from '../ui/Orb';
import { Voiceprint } from '../ui/Voiceprint';
import { StatusBadge } from '../ui/StatusBadge';

export function ModelCard({ model }: { model: ModelCardType }): JSX.Element {
  return (
    <Link
      to={`/models/${model.userId}`}
      className="block rounded-2xl bg-velvet p-5 transition-transform hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ember"
    >
      <div className="flex items-center gap-4">
        <Orb seed={model.userId} />
        <div className="min-w-0">
          <h3 className="font-display text-2xl text-cream truncate">{model.stageName}</h3>
          <StatusBadge status={model.status} />
        </div>
      </div>
      <div className="mt-4">
        <Voiceprint seed={model.userId} alive={model.status === 'ONLINE'} />
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="font-mono text-sm text-cream">⌗ {model.pricePerMinute} créditos/min</span>
      </div>
      {model.tags.length > 0 && (
        <p className="mt-3 text-mist text-sm">{model.tags.map((t) => `#${t}`).join('  ')}</p>
      )}
    </Link>
  );
}
```

- [ ] **Step 9: DiscoveryPage**

Create `web/src/discovery/DiscoveryPage.tsx` (replacing the stub from Task 3):
```tsx
import { useModels } from './useModels';
import { ModelCard } from './ModelCard';
import { useAuth } from '../auth/auth-context';

export function DiscoveryPage(): JSX.Element {
  const { data, isLoading, isError, refetch } = useModels();
  const { logout } = useAuth();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-baseline justify-between">
        <h1 className="font-display text-4xl text-cream">Quem você quer ouvir?</h1>
        <button onClick={() => void logout()} className="text-mist text-sm hover:text-cream">sair</button>
      </header>

      <section className="mt-10">
        {isLoading && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-48 rounded-2xl bg-velvet animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <div className="text-center text-mist">
            <p>Não foi possível carregar as vozes.</p>
            <button onClick={() => void refetch()} className="mt-3 rounded-full bg-ember px-5 py-2 text-void">tentar de novo</button>
          </div>
        )}

        {data && data.length === 0 && (
          <p className="text-center text-mist">Nenhuma voz disponível agora. Volte mais tarde.</p>
        )}

        {data && data.length > 0 && (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((m) => <ModelCard key={m.userId} model={m} />)}
          </div>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 10: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/discovery/discovery.test.tsx src/ui/StatusBadge.test.tsx`
Expected: PASS (StatusBadge 1 + discovery 3).

- [ ] **Step 11: tsc + commit**

Run (in `web/`): `npx tsc --noEmit` → limpo.
```bash
git add web/src
git commit -m "feat(web): descoberta — orb + voiceprint vivo + card + lista (estados loading/vazio/erro)"
```

---

## Task 5: Perfil da modelo (+ favoritar + botão de chamada disabled)

**Files:**
- Create: `web/src/profile/useModel.ts`, `web/src/profile/useFavorite.ts`, `web/src/profile/ModelProfilePage.tsx` (replacing the Task 3 stub)
- Test: `web/src/profile/profile.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ModelCard` type, react-router `useParams`.
- Produces: `useModel(id)` (→ `ModelCard`); `useFavorite(id)` (mutations add/remove favorito, invalida `['model', id]`); `<ModelProfilePage>`.

- [ ] **Step 1: Escrever os testes (falham)**

Create `web/src/profile/profile.test.tsx`:
```tsx
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelProfilePage } from './ModelProfilePage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';
import type { ModelCard } from '../types/api';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
const profile: ModelCard = { userId: 'm1', stageName: 'Lara', bio: 'voz suave', pricePerMinute: '4.00', tags: ['suave'], voicePreviewUrl: null, status: 'ONLINE', isFavorite: false };
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/models/m1']}>
        <Routes><Route path="/models/:id" element={<ModelProfilePage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

it('mostra o perfil e o botão de chamada desabilitado', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, profile)));
  render(wrap());
  await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /chamada/i })).toBeDisabled();
});

it('favoritar chama POST /favorites/:id', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(jsonResponse(200, profile))       // GET /models/m1
    .mockResolvedValueOnce(jsonResponse(200, { ok: true }))  // POST /favorites/m1
    .mockResolvedValue(jsonResponse(200, { ...profile, isFavorite: true })); // refetch
  vi.stubGlobal('fetch', fetchMock);
  render(wrap());
  await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /favoritar/i }));
  await waitFor(() => {
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/favorites/m1'));
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe('POST');
  });
});

it('404 mostra "não encontrada"', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { message: 'not found' })));
  render(wrap());
  await waitFor(() => expect(screen.getByText(/não encontrada/i)).toBeInTheDocument());
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/profile/profile.test.tsx`
Expected: FAIL — `ModelProfilePage` real não existe (ainda é stub).

- [ ] **Step 3: useModel**

Create `web/src/profile/useModel.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ModelCard } from '../types/api';

export function useModel(id: string): ReturnType<typeof useQuery<ModelCard>> {
  return useQuery<ModelCard>({
    queryKey: ['model', id],
    queryFn: () => apiFetch<ModelCard>(`/models/${id}`, { auth: true }),
  });
}
```

- [ ] **Step 4: useFavorite**

Create `web/src/profile/useFavorite.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useFavorite(id: string): { toggle: (isFavorite: boolean) => void; pending: boolean } {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (isFavorite: boolean) =>
      apiFetch(`/favorites/${id}`, { method: isFavorite ? 'DELETE' : 'POST', auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['model', id] }); },
  });
  return { toggle: (isFavorite: boolean) => mutation.mutate(isFavorite), pending: mutation.isPending };
}
```

- [ ] **Step 5: ModelProfilePage**

Replace `web/src/profile/ModelProfilePage.tsx` with:
```tsx
import { Link, useParams } from 'react-router-dom';
import { useModel } from './useModel';
import { useFavorite } from './useFavorite';
import { Orb } from '../ui/Orb';
import { Voiceprint } from '../ui/Voiceprint';
import { StatusBadge } from '../ui/StatusBadge';
import { ApiError } from '../lib/api-client';

export function ModelProfilePage(): JSX.Element {
  const { id = '' } = useParams();
  const { data: model, isLoading, error } = useModel(id);
  const { toggle, pending } = useFavorite(id);

  if (isLoading) {
    return <main className="mx-auto max-w-2xl px-6 py-10"><div className="h-64 rounded-2xl bg-velvet animate-pulse" /></main>;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <main className="mx-auto max-w-2xl px-6 py-16 text-center text-mist"><p>Voz não encontrada.</p><Link to="/" className="mt-4 inline-block text-ember">voltar</Link></main>;
  }
  if (!model) {
    return <main className="mx-auto max-w-2xl px-6 py-16 text-center text-mist"><p>Algo deu errado.</p><Link to="/" className="mt-4 inline-block text-ember">voltar</Link></main>;
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link to="/" className="text-mist text-sm hover:text-cream">← voltar</Link>
      <div className="mt-6 flex items-center gap-5">
        <Orb seed={model.userId} size={96} />
        <div>
          <h1 className="font-display text-5xl text-cream">{model.stageName}</h1>
          <div className="mt-2"><StatusBadge status={model.status} /></div>
        </div>
      </div>

      <div className="mt-8"><Voiceprint seed={model.userId} alive={model.status === 'ONLINE'} /></div>

      {model.bio && <p className="mt-6 text-cream/90 leading-relaxed">{model.bio}</p>}
      {model.tags.length > 0 && <p className="mt-4 text-mist">{model.tags.map((t) => `#${t}`).join('  ')}</p>}

      <p className="mt-6 font-mono text-cream">⌗ {model.pricePerMinute} créditos/min</p>

      <div className="mt-10 flex gap-3">
        <button
          type="button"
          disabled
          title="em breve"
          className="rounded-full bg-ember/40 px-6 py-3 text-void/70 cursor-not-allowed"
        >
          Iniciar chamada (em breve)
        </button>
        <button
          type="button"
          onClick={() => toggle(model.isFavorite)}
          disabled={pending}
          aria-pressed={model.isFavorite}
          className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember disabled:opacity-50"
        >
          {model.isFavorite ? 'Remover dos favoritos' : 'Favoritar'}
        </button>
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/profile/profile.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 7: tsc + commit**

Run (in `web/`): `npx tsc --noEmit` → limpo.
```bash
git add web/src
git commit -m "feat(web): perfil da modelo + favoritar + botão de chamada (em breve)"
```

---

## Task 6: README + env + verificação final

**Files:**
- Create: `web/.env.example`, `web/README.md`
- Modify: confirmar `web/.gitignore` cobre `.env`

- [ ] **Step 1: `.env.example`**

Create `web/.env.example`:
```bash
# URL do backend NestJS (sem barra final). Em dev local: http://localhost:3000
VITE_API_URL="http://localhost:3000"
# Client ID do Google OAuth (mesmo do backend GOOGLE_CLIENT_ID). Sem ele, o login fica desabilitado.
VITE_GOOGLE_CLIENT_ID=""
```

- [ ] **Step 2: Garantir `.env` gitignored**

Confirm `web/.gitignore` (criado pelo Vite) contém `.env` / `*.local`. Se não tiver `.env`, adicione uma linha `.env`.

- [ ] **Step 3: README**

Create `web/README.md`:
````markdown
# Samy — Web (porta de entrada do cliente)

SPA React/Vite que consome a API Samy. Login Google → descoberta de vozes → perfil.

## Rodar
```bash
cp .env.example .env   # preencha VITE_API_URL e VITE_GOOGLE_CLIENT_ID
npm install
npm run dev
```

## Login (ao vivo)
Precisa de um Google OAuth Client ID em `VITE_GOOGLE_CLIENT_ID` (o mesmo `GOOGLE_CLIENT_ID`
do backend). Sem ele, a tela de login mostra um aviso e o resto não autentica.

## Testes
```bash
npx vitest run     # unidade/componente (boundary de API mockado)
npx tsc --noEmit   # tipos
npm run build      # build de produção
```

## Design
"Candlelit after-midnight": tema escuro ameixa, brilho ember/gold, anonimato (sem rostos —
orb de gradiente + voiceprint que pulsa quando a voz está online). Tokens em `src/index.css`.
````

- [ ] **Step 4: Verificação final**

Run (in `web/`):
```
npx tsc --noEmit
npx vitest run
npm run build
```
Expected: tsc limpo; **todos** os testes verdes (api-client 4 + auth 3 + StatusBadge 1 + discovery 3 + profile 3 = 14); build conclui.

- [ ] **Step 5: Commit e push**

```bash
git add web
git commit -m "docs(web): .env.example + README + verificação final"
git push origin main
```

---

## Self-Review (autor)

**Cobertura do spec:**
- §3 scaffold/stack (Vite/React/TS/Tailwind/Router/Query/Vitest) → Task 1. ✓
- §3.1 client de API + refresh-no-401 → Task 2 (+4 testes). ✓
- §3.2 sessão localStorage → Task 2. ✓
- §3.3 AuthProvider/LoginPage(GIS)/ProtectedRoute → Task 3 (+3 testes). ✓
- §3.4 descoberta (useModels, card, status, estados) → Task 4 (+4 testes). ✓
- §3.5 perfil + favoritar + botão disabled → Task 5 (+3 testes). ✓
- §7b design language (tokens, fontes, voiceprint vivo, orb, reduced-motion) → Tasks 1/4. ✓
- Anonimato (só stageName) → teste explícito na Task 4 (`queryByText('A')` ausente). ✓
- §6 testes mockando boundary; §2 build/test sem credencial → todas as tasks. ✓
- README + env → Task 6. ✓

**Consistência de tipos:** `ModelCard` idêntico ao backend; `apiFetch<T>(path,{method,body,auth})`, `ApiError{status,message}`, `Session{accessToken,refreshToken,user}`, `useAuth(){user,login,logout}`, `hueFromId(id)`, `Voiceprint{seed,alive}`, `Orb{seed,size?}`, `StatusBadge{status}` — usados de forma idêntica em todas as tasks.

**Placeholders:** nenhum — todo passo tem código/comando concreto. (Os stubs de DiscoveryPage/ModelProfilePage na Task 3 são explicitamente temporários e substituídos nas Tasks 4/5.)

**Risco conhecido:** versões de libs (Tailwind v4, RRD v7, RQ v5) podem trazer pequenas diferenças de API; cada task roda `tsc` + testes como gate, então quebras aparecem cedo. GIS (login real) é verificado manualmente pós-credencial (Task 6 / README), não nos testes.
