# Experiência de Chamada (voz, LiveKit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cliente liga pra uma modelo online, ela atende, e os dois conversam por voz (LiveKit) — UI dos dois lados + sinalização por polling.

**Architecture:** Backend só adiciona `GET /calls/incoming` (a modelo descobrir a chamada). Front: `livekit-client` atrás de um wrapper mockável (`lib/call-media`), uma `CallScreen` compartilhada que faz poll de `GET /calls/:id` e conecta o áudio quando ACTIVE, o cliente inicia no perfil, e a modelo recebe via `IncomingCallWatcher` no painel.

**Tech Stack:** NestJS/Prisma, Jest e2e; React/Vite, TanStack Query, `livekit-client`, Vitest.

## Global Constraints

- `GET /calls/incoming` (`@Roles('MODEL')`) → `{ call: Call | null }` via `CallService.incomingFor(modelId)` (REQUESTED de `modelUserId`, `requestedAt` dentro do RING_TIMEOUT, mais recente). Não altera o motor de chamadas existente.
- Front usa os endpoints existentes inalterados: `POST /calls {modelId}` (CLIENT), `POST /calls/:id/accept|reject|hangup|panic`, `GET /calls/:id` → `{call, media?}` (media `{token,url}` quando ACTIVE).
- Áudio atrás de `lib/call-media.ts` (mockável); nenhum teste fala com LiveKit real.
- Polling: `GET /calls/:id` 2s enquanto status !== 'ENDED'; `GET /calls/incoming` 3s.
- Anonimato: mostra `stageName`/"Cliente"; nunca nome real.
- `import type` em tipos. Backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo. Front testa com boundary + call-media mockados.

---

## File Structure

```
src/calls/call.service.ts          + incomingFor                            [mod]
src/calls/call.controller.ts       + GET incoming                           [mod]
test/call.incoming.e2e-spec.ts                                             [novo]
web/package.json                   + livekit-client                         [mod]
web/src/types/api.ts               + Call, MediaToken, CallView             [mod]
web/src/lib/call-media.ts                                                  [novo]
web/src/calls/useCall.ts / useCallActions.ts / useIncomingCall.ts          [novo]
web/src/calls/CallScreen.tsx                                               [novo]
web/src/calls/IncomingCallWatcher.tsx                                      [novo]
web/src/calls/call.test.tsx                                                [novo]
web/src/App.tsx                    + rota /call/:id                         [mod]
web/src/profile/ModelProfilePage.tsx  habilita iniciar (ONLINE)            [mod]
web/src/model/ModelDashboard.tsx   + <IncomingCallWatcher/>                 [mod]
```

Backend e2e: `npx jest --config ./jest-integration.json --runInBand <file>`. Front: `cd web && npx vitest run <file>`.

---

## Task 1: Backend — `GET /calls/incoming`

**Files:**
- Modify: `src/calls/call.service.ts`, `src/calls/call.controller.ts`
- Test: `test/call.incoming.e2e-spec.ts`

**Interfaces:**
- Produces: `CallService.incomingFor(modelId: string): Promise<Call | null>`; `GET /calls/incoming` (MODEL) → `{ call: Call | null }`.

- [ ] **Step 1: Escrever o e2e que falha**

Create `test/call.incoming.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('GET /calls/incoming', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
    tokens = mod.get(TokenService);
  });
  beforeEach(async () => { await prisma.call.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });

  async function user(role: 'CLIENT' | 'MODEL'): Promise<{ id: string; token: string }> {
    const u = await prisma.user.create({ data: { id: `${role}-${Math.random().toString(36).slice(2)}`, role, provider: 'google', providerSubject: `s-${Math.random()}`, email: 'u@x.com', displayName: 'U', status: 'ACTIVE' } });
    return { id: u.id, token: tokens.signAccess({ id: u.id, role }) };
  }

  it('devolve a chamada REQUESTED destinada à modelo', async () => {
    const m = await user('MODEL');
    const c = await user('CLIENT');
    const call = await prisma.call.create({ data: { clientUserId: c.id, modelUserId: m.id, status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00') } });
    const res = await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.call?.id).toBe(call.id);
  });

  it('null quando não há chamada pendente', async () => {
    const m = await user('MODEL');
    const res = await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.call).toBeNull();
  });

  it('não conta chamada REQUESTED expirada', async () => {
    const m = await user('MODEL');
    const c = await user('CLIENT');
    await prisma.call.create({ data: { clientUserId: c.id, modelUserId: m.id, status: 'REQUESTED', pricePerMinuteSnapshot: new Prisma.Decimal('5.00'), requestedAt: new Date(Date.now() - 120000) } });
    const res = await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${m.token}`).expect(200);
    expect(res.body.call).toBeNull();
  });

  it('CLIENT → 403', async () => {
    const c = await user('CLIENT');
    await request(app.getHttpServer()).get('/calls/incoming').set('Authorization', `Bearer ${c.token}`).expect(403);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/call.incoming.e2e-spec.ts`
Expected: FAIL — rota inexistente.

- [ ] **Step 3: `incomingFor` na service**

In `src/calls/call.service.ts`, add this method to the class (the file already has `RING_TIMEOUT_SECONDS` const and `prisma`):
```ts
  async incomingFor(modelId: string): Promise<Call | null> {
    return this.prisma.call.findFirst({
      where: {
        modelUserId: modelId,
        status: 'REQUESTED',
        requestedAt: { gt: new Date(Date.now() - RING_TIMEOUT_SECONDS * 1000) },
      },
      orderBy: { requestedAt: 'desc' },
    });
  }
```

- [ ] **Step 4: Rota no controller**

In `src/calls/call.controller.ts`, add inside the class (before `@Get(':id')` so `incoming` isn't captured by `:id`):
```ts
  @Get('incoming')
  @Roles('MODEL')
  async incoming(@Req() req: Request & { user: AuthUser }): Promise<{ call: unknown }> {
    return { call: await this.calls.incomingFor(req.user.id) };
  }
```
(`Get`, `Req`, `Roles`, `AuthUser`, `Request` já estão importados no arquivo.)

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/call.incoming.e2e-spec.ts`
Expected: PASS (4/4).

- [ ] **Step 6: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/calls/call.service.ts src/calls/call.controller.ts test/call.incoming.e2e-spec.ts
git commit -m "feat(calls): GET /calls/incoming (modelo descobre chamada recebida)"
```

---

## Task 2: Frontend — wrapper LiveKit + tipos

**Files:**
- Modify: `web/package.json` (livekit-client), `web/src/types/api.ts`
- Create: `web/src/lib/call-media.ts`

**Interfaces:**
- Produces: `connectCallRoom(url, token): Promise<CallRoomHandle>`; `CallRoomHandle { setMuted(m): void; disconnect(): Promise<void> }`; tipos `Call`, `MediaToken`, `CallView`.

- [ ] **Step 1: Instalar livekit-client**

Run (in `web/`): `npm i livekit-client`

- [ ] **Step 2: Tipos**

In `web/src/types/api.ts`, add:
```ts
export interface MediaToken { token: string; url: string; }

export interface Call {
  id: string;
  clientUserId: string;
  modelUserId: string;
  status: 'REQUESTED' | 'ACTIVE' | 'ENDED';
  endReason: string | null;
  pricePerMinuteSnapshot: string;
  roomName: string | null;
  startedAt: string | null;
}

export interface CallView { call: Call; media?: MediaToken; }
```

- [ ] **Step 3: call-media.ts**

Create `web/src/lib/call-media.ts`:
```ts
import { Room, RoomEvent, Track } from 'livekit-client';
import type { RemoteTrack } from 'livekit-client';

export interface CallRoomHandle {
  setMuted(muted: boolean): void;
  disconnect(): Promise<void>;
}

export async function connectCallRoom(url: string, token: string): Promise<CallRoomHandle> {
  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.style.display = 'none';
      document.body.appendChild(el);
    }
  });
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  return {
    setMuted: (muted: boolean): void => { void room.localParticipant.setMicrophoneEnabled(!muted); },
    disconnect: async (): Promise<void> => { await room.disconnect(); },
  };
}
```

- [ ] **Step 4: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/package.json web/package-lock.json web/src/types/api.ts web/src/lib/call-media.ts
git commit -m "feat(web): wrapper LiveKit (connectCallRoom) + tipos de chamada"
```

---

## Task 3: Frontend — CallScreen + hooks + rota

**Files:**
- Create: `web/src/calls/useCall.ts`, `useCallActions.ts`, `CallScreen.tsx`, `call.test.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `connectCallRoom`/`CallRoomHandle`, `useAuth`, tipos.
- Produces: `useCall(id)`, `useCallActions()`; `<CallScreen>` em `/call/:id`.

- [ ] **Step 1: Escrever os testes (falham)**

Create `web/src/calls/call.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '../auth/auth-context';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

vi.mock('../lib/call-media', () => ({
  connectCallRoom: vi.fn().mockResolvedValue({ setMuted: vi.fn(), disconnect: vi.fn().mockResolvedValue(undefined) }),
}));
import { connectCallRoom } from '../lib/call-media';
import { CallScreen } from './CallScreen';

function sess(role: 'CLIENT' | 'MODEL'): Session {
  return { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role, status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/call/c1']}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>home</div>} />
            <Route path="/call/:id" element={<CallScreen />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const baseCall = { id: 'c1', clientUserId: 'cli', modelUserId: 'mod', endReason: null, pricePerMinuteSnapshot: '5.00', roomName: 'call:c1', startedAt: null };
beforeEach(() => { localStorage.clear(); setSession(sess('CLIENT')); });
afterEach(() => vi.restoreAllMocks());

describe('CallScreen', () => {
  it('REQUESTED mostra "Chamando" e Desligar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: { ...baseCall, status: 'REQUESTED' } })));
    render(wrap());
    await waitFor(() => expect(screen.getByText(/chamando/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /desligar/i })).toBeInTheDocument();
  });

  it('ACTIVE conecta o áudio (connectCallRoom) e mostra Desligar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: { ...baseCall, status: 'ACTIVE', startedAt: new Date().toISOString() }, media: { token: 'tk', url: 'wss://x' } })));
    render(wrap());
    await waitFor(() => expect(connectCallRoom).toHaveBeenCalledWith('wss://x', 'tk'));
    expect(screen.getByRole('button', { name: /desligar/i })).toBeInTheDocument();
  });

  it('Desligar chama POST hangup', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/calls/c1/hangup') && init?.method === 'POST') return Promise.resolve(json(200, { ...baseCall, status: 'ENDED' }));
      return Promise.resolve(json(200, { call: { ...baseCall, status: 'ACTIVE', startedAt: new Date().toISOString() }, media: { token: 'tk', url: 'wss://x' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await screen.findByRole('button', { name: /desligar/i });
    await userEvent.click(screen.getByRole('button', { name: /desligar/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/calls/c1/hangup'))).toBe(true));
  });

  it('ENDED mostra o motivo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: { ...baseCall, status: 'ENDED', endReason: 'HANGUP_CLIENT' } })));
    render(wrap());
    await waitFor(() => expect(screen.getByText(/encerrada/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/calls/call.test.tsx`
Expected: FAIL — módulos não existem.

- [ ] **Step 3: useCall**

Create `web/src/calls/useCall.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { CallView } from '../types/api';

export function useCall(id: string): ReturnType<typeof useQuery<CallView>> {
  return useQuery<CallView>({
    queryKey: ['call', id],
    queryFn: () => apiFetch<CallView>(`/calls/${id}`, { auth: true }),
    enabled: !!id,
    refetchInterval: (query) => (query.state.data?.call.status === 'ENDED' ? false : 2000),
  });
}
```

- [ ] **Step 4: useCallActions**

Create `web/src/calls/useCallActions.ts`:
```ts
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Call } from '../types/api';

export function useCallActions(): {
  initiate: ReturnType<typeof useMutation<Call, Error, string>>;
  accept: ReturnType<typeof useMutation<unknown, Error, string>>;
  reject: ReturnType<typeof useMutation<unknown, Error, string>>;
  hangup: ReturnType<typeof useMutation<unknown, Error, string>>;
  panic: ReturnType<typeof useMutation<unknown, Error, string>>;
} {
  const initiate = useMutation<Call, Error, string>({ mutationFn: (modelId) => apiFetch<Call>('/calls', { method: 'POST', body: { modelId }, auth: true }) });
  const accept = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/accept`, { method: 'POST', auth: true }) });
  const reject = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/reject`, { method: 'POST', auth: true }) });
  const hangup = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/hangup`, { method: 'POST', auth: true }) });
  const panic = useMutation<unknown, Error, string>({ mutationFn: (id) => apiFetch(`/calls/${id}/panic`, { method: 'POST', auth: true }) });
  return { initiate, accept, reject, hangup, panic };
}
```

- [ ] **Step 5: CallScreen**

Create `web/src/calls/CallScreen.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { connectCallRoom } from '../lib/call-media';
import type { CallRoomHandle } from '../lib/call-media';
import { useCall } from './useCall';
import { useCallActions } from './useCallActions';

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function CallScreen(): JSX.Element {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { data } = useCall(id);
  const { hangup, panic } = useCallActions();
  const handleRef = useRef<CallRoomHandle | null>(null);
  const [muted, setMuted] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const call = data?.call;
  const media = data?.media;
  const status = call?.status;
  const isModel = user?.role === 'MODEL';

  useEffect(() => {
    if (status === 'ACTIVE' && media && !handleRef.current) {
      connectCallRoom(media.url, media.token)
        .then((h) => { handleRef.current = h; })
        .catch(() => setAudioError(true));
    }
  }, [status, media]);

  useEffect(() => {
    if (status === 'ENDED' && handleRef.current) {
      void handleRef.current.disconnect();
      handleRef.current = null;
    }
  }, [status]);

  useEffect(() => () => { void handleRef.current?.disconnect(); }, []);

  useEffect(() => {
    if (status !== 'ACTIVE' || !call?.startedAt) return;
    const started = new Date(call.startedAt).getTime();
    const tick = (): void => setElapsed((Date.now() - started) / 1000);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [status, call?.startedAt]);

  const toggleMute = (): void => { const m = !muted; setMuted(m); handleRef.current?.setMuted(m); };
  const onHangup = (): void => { hangup.mutate(id, { onSuccess: () => { void handleRef.current?.disconnect(); handleRef.current = null; } }); };

  return (
    <main className="min-h-screen grid place-items-center px-6 text-center">
      <div className="max-w-sm">
        {status === 'ENDED' ? (
          <>
            <h1 className="font-display text-4xl text-cream">Chamada encerrada</h1>
            {call?.endReason && <p className="mt-2 text-mist text-sm">{call.endReason}</p>}
            <Link to={isModel ? '/painel' : '/'} className="mt-6 inline-block text-ember">voltar</Link>
          </>
        ) : status === 'ACTIVE' ? (
          <>
            <p className="text-mist text-sm">{isModel ? 'Em chamada com o cliente' : 'Em chamada'}</p>
            <p className="mt-2 font-mono text-5xl text-cream">{fmt(elapsed)}</p>
            {audioError && <p className="mt-3 text-ember text-sm">Não foi possível conectar o áudio.</p>}
            <div className="mt-8 flex justify-center gap-3">
              <button onClick={toggleMute} className="rounded-full border border-mist/40 px-5 py-3 text-cream hover:border-ember">{muted ? 'Reativar' : 'Mutar'}</button>
              <button onClick={onHangup} className="rounded-full bg-ember px-6 py-3 text-void">Desligar</button>
              {isModel && <button onClick={() => panic.mutate(id)} className="rounded-full border border-ember/60 px-5 py-3 text-ember">Pânico</button>}
            </div>
          </>
        ) : (
          <>
            <h1 className="font-display text-4xl text-cream">Chamando…</h1>
            <p className="mt-2 text-mist text-sm">aguardando atender</p>
            <button onClick={onHangup} className="mt-8 rounded-full bg-ember px-6 py-3 text-void">Desligar</button>
          </>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Rota /call/:id**

In `web/src/App.tsx`, import `CallScreen` and add the protected route:
```tsx
import { CallScreen } from './calls/CallScreen';
```
```tsx
      <Route path="/call/:id" element={<ProtectedRoute><CallScreen /></ProtectedRoute>} />
```

- [ ] **Step 7: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/calls/call.test.tsx`
Expected: PASS (4/4). Depois `npx vitest run` (suíte inteira) verde.

- [ ] **Step 8: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/calls web/src/App.tsx
git commit -m "feat(web): CallScreen — chamada de voz (poll + LiveKit + cronômetro + desligar)"
```

---

## Task 4: Frontend — iniciar chamada no perfil

**Files:**
- Modify: `web/src/profile/ModelProfilePage.tsx`, `web/src/profile/profile.test.tsx`

**Interfaces:**
- Consumes: `useCallActions().initiate`, `useNavigate`.

- [ ] **Step 1: Atualizar o teste do perfil (falha)**

In `web/src/profile/profile.test.tsx`, replace the existing assertion that the call button is disabled. Find the test `'mostra o perfil e o botão de chamada desabilitado'` and change its body so the profile mock returns `status: 'ONLINE'` and the button becomes enabled and initiates. Replace that `it(...)` with:
```tsx
it('com modelo ONLINE, "Iniciar chamada" inicia e navega', async () => {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models/m1') && (!init || init.method === undefined)) return Promise.resolve(json(200, { ...profile, status: 'ONLINE' }));
    if (u.endsWith('/calls') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'newcall' }));
    return Promise.resolve(json(200, {}));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(wrap());
  await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
  const btn = screen.getByRole('button', { name: /iniciar chamada/i });
  expect(btn).not.toBeDisabled();
  await userEvent.click(btn);
  await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/calls') && (c[1] as RequestInit)?.method === 'POST')).toBe(true));
});
```
(If `profile` in that file has `status: 'ONLINE'` already, keep the per-call override above. Ensure `userEvent` is imported in the file — add `import userEvent from '@testing-library/user-event';` if missing.)

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/profile/profile.test.tsx`
Expected: FAIL — o botão ainda é fixo-desabilitado / não inicia.

- [ ] **Step 3: Habilitar o botão e iniciar**

In `web/src/profile/ModelProfilePage.tsx`, import the action hook + navigate:
```tsx
import { useNavigate } from 'react-router-dom';
import { useCallActions } from '../calls/useCallActions';
```
Inside the component, add:
```tsx
  const navigate = useNavigate();
  const { initiate } = useCallActions();
```
Replace the disabled call button block:
```tsx
        <button
          type="button"
          disabled
          title="em breve"
          className="rounded-full bg-ember/40 px-6 py-3 text-void/70 cursor-not-allowed"
        >
          Iniciar chamada (em breve)
        </button>
```
with:
```tsx
        <button
          type="button"
          disabled={model.status !== 'ONLINE' || initiate.isPending}
          onClick={() => initiate.mutate(model.userId, { onSuccess: (call) => navigate(`/call/${call.id}`) })}
          className="rounded-full bg-ember px-6 py-3 text-void disabled:bg-ember/40 disabled:text-void/70 disabled:cursor-not-allowed"
        >
          {model.status === 'ONLINE' ? 'Iniciar chamada' : 'Indisponível'}
        </button>
        {initiate.isError && <p className="mt-3 text-ember text-sm">Não foi possível iniciar (saldo ou disponibilidade).</p>}
```

- [ ] **Step 4: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/profile/profile.test.tsx`
Expected: PASS. Depois `npx vitest run` (suíte inteira) verde.

- [ ] **Step 5: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/profile
git commit -m "feat(web): perfil — iniciar chamada quando a modelo está ONLINE"
```

---

## Task 5: Frontend — IncomingCallWatcher (modelo)

**Files:**
- Create: `web/src/calls/useIncomingCall.ts`, `web/src/calls/IncomingCallWatcher.tsx`
- Modify: `web/src/model/ModelDashboard.tsx`
- Test: `web/src/calls/incoming.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `useCallActions().accept/reject`, `useNavigate`, tipo `Call`.
- Produces: `<IncomingCallWatcher/>` (overlay no painel).

- [ ] **Step 1: Escrever o teste (falha)**

Create `web/src/calls/incoming.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { IncomingCallWatcher } from './IncomingCallWatcher';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'm1', role: 'MODEL', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<IncomingCallWatcher />} />
          <Route path="/call/:id" element={<div>tela de chamada</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('IncomingCallWatcher', () => {
  it('mostra a chamada recebida e Aceitar chama POST accept', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/calls/inc1/accept') && init?.method === 'POST') return Promise.resolve(json(200, { call: { id: 'inc1' }, media: { token: 't', url: 'wss://x' } }));
      if (u.endsWith('/calls/incoming')) return Promise.resolve(json(200, { call: { id: 'inc1', clientUserId: 'c', modelUserId: 'm1', status: 'REQUESTED', endReason: null, pricePerMinuteSnapshot: '5.00', roomName: null, startedAt: null } }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap());
    await waitFor(() => expect(screen.getByText(/chamada recebida/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /aceitar/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/calls/inc1/accept'))).toBe(true));
  });

  it('sem chamada não mostra nada', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { call: null })));
    render(wrap());
    await waitFor(() => expect(screen.queryByText(/chamada recebida/i)).not.toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/calls/incoming.test.tsx`
Expected: FAIL — `IncomingCallWatcher` não existe.

- [ ] **Step 3: useIncomingCall**

Create `web/src/calls/useIncomingCall.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { Call } from '../types/api';

export function useIncomingCall(enabled: boolean): ReturnType<typeof useQuery<{ call: Call | null }>> {
  return useQuery<{ call: Call | null }>({
    queryKey: ['incoming'],
    queryFn: () => apiFetch<{ call: Call | null }>('/calls/incoming', { auth: true }),
    enabled,
    refetchInterval: 3000,
  });
}
```

- [ ] **Step 4: IncomingCallWatcher**

Create `web/src/calls/IncomingCallWatcher.tsx`:
```tsx
import { useNavigate } from 'react-router-dom';
import { useIncomingCall } from './useIncomingCall';
import { useCallActions } from './useCallActions';

export function IncomingCallWatcher(): JSX.Element | null {
  const navigate = useNavigate();
  const { data } = useIncomingCall(true);
  const { accept, reject } = useCallActions();
  const call = data?.call;
  if (!call) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-void/80 px-6">
      <div className="rounded-2xl bg-velvet p-8 text-center max-w-sm">
        <p className="text-mist text-sm">Chamada recebida</p>
        <h2 className="mt-2 font-display text-3xl text-cream">Alguém quer te ouvir</h2>
        <div className="mt-8 flex justify-center gap-3">
          <button
            onClick={() => accept.mutate(call.id, { onSuccess: () => navigate(`/call/${call.id}`) })}
            className="rounded-full bg-gold px-6 py-3 text-void"
          >
            Aceitar
          </button>
          <button
            onClick={() => reject.mutate(call.id)}
            className="rounded-full border border-mist/40 px-6 py-3 text-cream hover:border-ember"
          >
            Recusar
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Montar no ModelDashboard**

In `web/src/model/ModelDashboard.tsx`, import and render `<IncomingCallWatcher/>` (após o `<header>`, dentro do `<main>`):
```tsx
import { IncomingCallWatcher } from '../calls/IncomingCallWatcher';
```
```tsx
      <IncomingCallWatcher />
```

- [ ] **Step 6: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/calls/incoming.test.tsx`
Expected: PASS (2/2). Depois `npx vitest run` (suíte inteira) verde.

- [ ] **Step 7: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/calls web/src/model/ModelDashboard.tsx
git commit -m "feat(web): IncomingCallWatcher — modelo recebe e atende chamada"
```

---

## Task 6: Verificação final + push

- [ ] **Step 1:** `npm run test:int` → verde.
- [ ] **Step 2:** (in `web/`) `npx vitest run` e `npm run build` → verdes.
- [ ] **Step 3 (manual, com LIVEKIT_* no backend):** cliente abre perfil de modelo ONLINE → "Iniciar chamada"; modelo no `/painel` (online) vê o overlay → Aceitar → os dois entram na CallScreen, áudio conecta, cronômetro corre, desligar encerra. Sem chaves: o fluxo para no "Chamando" (accept 500) — esperado.
- [ ] **Step 4:** `git push origin main`.

---

## Self-Review (autor)

**Cobertura do spec:** §4.1 incomingFor + GET incoming → T1; §4.3 call-media wrapper + tipos → T2; §4.5 CallScreen (poll/connect/timer/mute/hangup/panic) + hooks + rota → T3; §4.6 iniciar (perfil ONLINE) → T4; §4.6 IncomingCallWatcher → T5; §6 testes → T1/T3/T4/T5; §7 manual → T6.

**Consistência de tipos:** `Call.status` ('REQUESTED'|'ACTIVE'|'ENDED'); `CallView {call, media?}`; `MediaToken {token,url}`; `connectCallRoom(url, token)→CallRoomHandle{setMuted,disconnect}`; rotas `/calls`, `/calls/:id`, `/calls/:id/accept|reject|hangup|panic`, `/calls/incoming` idênticas back/front. `useCall`/`useCallActions`/`useIncomingCall` consumidos igual.

**Placeholders:** nenhum — código/comando concreto. Gate de tipos do front = `npm run build`. call-media é glue de SDK (mockado nos testes; áudio real é verificação manual com chaves).
