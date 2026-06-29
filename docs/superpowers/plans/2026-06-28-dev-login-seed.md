# Dev-login + Seed de demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Logar com 1 clique sem Google (dev-only) e semear vozes de teste, pra andar pelo app localmente.

**Architecture:** Endpoint `POST /auth/dev-login` com dupla-trava de ambiente (DEV_LOGIN + NODE_ENV) que devolve tokens de um CLIENT fixo; script `seed-demo` que cria modelos ACTIVE + perfis + presença Redis + uma chamada OCUPADA; botão dev na LoginPage gated por VITE_DEV_LOGIN.

**Tech Stack:** NestJS, Prisma, ioredis, ts-node (seed); React/Vite (front), Vitest.

## Global Constraints

- `POST /auth/dev-login` só responde quando `process.env.DEV_LOGIN === 'true'` E `process.env.NODE_ENV !== 'production'`; senão `404 NotFound`. Checagem no handler.
- Produção nunca seta `DEV_LOGIN`; Dockerfile roda `NODE_ENV=production` (segunda trava). `.env.example` documenta `DEV_LOGIN` como dev-only.
- `devLogin()` cria/usa CLIENT fixo (`provider 'dev'`, `subject 'dev-client'`, `email 'dev@samy.local'`, `displayName 'Cliente Dev'`) e devolve `{ accessToken, refreshToken, user }` (mesmo shape de `/auth/google`).
- Seed cria modelos com `status:'ACTIVE'` via Prisma direto (idempotente, upsert por provider+subject).
- `import type` em interfaces injetadas; backend `npx tsc --noEmit` limpo; front `npm run build` limpo.
- Não alterar lógica existente; só adicionar.

---

## Task 1: Backend — `devLogin()` + rota `POST /auth/dev-login`

**Files:**
- Modify: `src/auth/auth.service.ts`
- Modify: `src/auth/auth.controller.ts`
- Test: `test/auth.dev-login.e2e-spec.ts`

**Interfaces:**
- Consumes: `UsersService.findByProvider(provider, subject)`, `UsersService.createUser({role,provider,subject,email,name})`, `TokenService.signAccess({id,role})`, `TokenService.issueRefresh(userId)`.
- Produces: `AuthService.devLogin(): Promise<{ accessToken: string; refreshToken: string; user: {id;role;status;email;displayName} }>`; rota `POST /auth/dev-login`.

- [ ] **Step 1: Escrever o e2e que falha**

Create `test/auth.dev-login.e2e-spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('POST /auth/dev-login', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const prev = process.env.DEV_LOGIN;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    prisma = mod.get(PrismaService);
  });
  beforeEach(async () => {
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany({ where: { provider: 'dev' } });
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.DEV_LOGIN; else process.env.DEV_LOGIN = prev;
    await app.close();
  });

  it('com DEV_LOGIN=true devolve sessão CLIENT', async () => {
    process.env.DEV_LOGIN = 'true';
    const res = await request(app.getHttpServer()).post('/auth/dev-login').expect(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.role).toBe('CLIENT');
    expect(res.body.user.email).toBe('dev@samy.local');
  });

  it('reutiliza o mesmo CLIENT dev em chamadas repetidas', async () => {
    process.env.DEV_LOGIN = 'true';
    const a = await request(app.getHttpServer()).post('/auth/dev-login').expect(201);
    const b = await request(app.getHttpServer()).post('/auth/dev-login').expect(201);
    expect(a.body.user.id).toBe(b.body.user.id);
  });

  it('com DEV_LOGIN desativado responde 404', async () => {
    delete process.env.DEV_LOGIN;
    await request(app.getHttpServer()).post('/auth/dev-login').expect(404);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest --config ./jest-integration.json --runInBand test/auth.dev-login.e2e-spec.ts`
Expected: FAIL — rota inexistente (404 nos dois primeiros / o terceiro passa por acidente).

- [ ] **Step 3: Adicionar `devLogin` ao AuthService**

In `src/auth/auth.service.ts`, add the method to the class (mirror the `loginOrRegister` user shape):
```ts
  async devLogin(): Promise<{ accessToken: string; refreshToken: string; user: { id: string; role: string; status: string; email: string; displayName: string } }> {
    const provider = 'dev';
    const subject = 'dev-client';
    let user = await this.users.findByProvider(provider, subject);
    if (!user) {
      user = await this.users.createUser({ role: 'CLIENT', provider, subject, email: 'dev@samy.local', name: 'Cliente Dev' });
    }
    const refreshToken = await this.tokens.issueRefresh(user.id);
    return {
      accessToken: this.tokens.signAccess({ id: user.id, role: user.role }),
      refreshToken,
      user: { id: user.id, role: user.role, status: user.status, email: user.email, displayName: user.displayName },
    };
  }
```

- [ ] **Step 4: Adicionar a rota com dupla-trava**

In `src/auth/auth.controller.ts`, add `NotFoundException` to the `@nestjs/common` import, and add the route inside the class:
```ts
  @Post('dev-login')
  async devLogin(): Promise<unknown> {
    if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }
    return this.auth.devLogin();
  }
```
(Update the import line to: `import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';`.)

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest --config ./jest-integration.json --runInBand test/auth.dev-login.e2e-spec.ts`
Expected: PASS (3/3).

- [ ] **Step 6: tsc + commit**

Run: `npx tsc --noEmit` → limpo.
```bash
git add src/auth/auth.service.ts src/auth/auth.controller.ts test/auth.dev-login.e2e-spec.ts
git commit -m "feat(auth): dev-login endpoint (dupla-trava DEV_LOGIN + NODE_ENV)"
```

---

## Task 2: Seed de demo (`seed-demo.ts` + script + env)

**Files:**
- Create: `prisma/seed-demo.ts`
- Modify: `package.json` (script `seed:demo`)
- Modify: `.env.example` (DEV_LOGIN)

**Interfaces:**
- Produces: `npm run seed:demo` — popula CLIENT dev + 6 modelos ACTIVE + perfis + presença + 1 OCUPADA.

- [ ] **Step 1: Criar o seed**

Create `prisma/seed-demo.ts`:
```ts
import { PrismaClient, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { config } from 'dotenv';

config();

interface DemoModel { sub: string; stageName: string; price: string; tags: string[]; bio: string; presence: 'ONLINE' | 'OCUPADA' | 'OFFLINE'; }

const MODELS: DemoModel[] = [
  { sub: 'm-lara', stageName: 'Lara', price: '4.00', tags: ['suave', 'grave'], bio: 'Voz de veludo pra noites longas.', presence: 'ONLINE' },
  { sub: 'm-bianca', stageName: 'Bianca', price: '6.00', tags: ['doce', 'sussurro'], bio: 'Sussurros que acalmam.', presence: 'ONLINE' },
  { sub: 'm-helena', stageName: 'Helena', price: '5.00', tags: ['firme', 'dominadora'], bio: 'No comando, sempre.', presence: 'ONLINE' },
  { sub: 'm-yara', stageName: 'Yara', price: '3.50', tags: ['carinhosa', 'calma'], bio: 'Conversa boa e colo.', presence: 'ONLINE' },
  { sub: 'm-sofia', stageName: 'Sofia', price: '8.00', tags: ['intensa', 'rouca'], bio: 'Intensidade do começo ao fim.', presence: 'OCUPADA' },
  { sub: 'm-nina', stageName: 'Nina', price: '4.50', tags: ['timida', 'fofa'], bio: 'Doçura tímida.', presence: 'OFFLINE' },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const client = await prisma.user.upsert({
      where: { provider_providerSubject: { provider: 'dev', providerSubject: 'dev-client' } },
      update: { status: 'ACTIVE' },
      create: { role: 'CLIENT', provider: 'dev', providerSubject: 'dev-client', email: 'dev@samy.local', displayName: 'Cliente Dev', status: 'ACTIVE' },
    });

    const ids: Record<string, string> = {};
    for (const m of MODELS) {
      const user = await prisma.user.upsert({
        where: { provider_providerSubject: { provider: 'dev', providerSubject: m.sub } },
        update: { status: 'ACTIVE' },
        create: { role: 'MODEL', provider: 'dev', providerSubject: m.sub, email: `${m.sub}@samy.local`, displayName: `Real ${m.stageName}`, status: 'ACTIVE' },
      });
      ids[m.sub] = user.id;
      await prisma.modelProfile.upsert({
        where: { userId: user.id },
        update: { stageName: m.stageName, pricePerMinute: new Prisma.Decimal(m.price), tags: m.tags, bio: m.bio },
        create: { userId: user.id, stageName: m.stageName, pricePerMinute: new Prisma.Decimal(m.price), tags: m.tags, bio: m.bio },
      });
    }

    // OCUPADA: uma chamada ACTIVE persistida (não depende de presença/TTL)
    const sofiaId = ids['m-sofia'];
    await prisma.call.deleteMany({ where: { modelUserId: sofiaId, status: 'ACTIVE' } });
    await prisma.call.create({
      data: { clientUserId: client.id, modelUserId: sofiaId, status: 'ACTIVE', pricePerMinuteSnapshot: new Prisma.Decimal('8.00'), startedAt: new Date(), roomName: `demo:${sofiaId}` },
    });

    // Presença ONLINE via Redis (TTL 30s — re-rode o seed pra reacender)
    const url = process.env.REDIS_URL;
    if (url) {
      const redis = new Redis(url);
      try {
        for (const m of MODELS) {
          if (m.presence === 'ONLINE') {
            await redis.set(`presence:model:${ids[m.sub]}`, 'ONLINE', 'EX', 30);
          }
        }
      } finally {
        await redis.quit();
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn('REDIS_URL ausente — modelos ONLINE ficarão OFFLINE (sem presença).');
    }

    // eslint-disable-next-line no-console
    console.log(`seed-demo ok: cliente dev + ${MODELS.length} modelos (4 ONLINE/TTL 30s, 1 OCUPADA, 1 OFFLINE).`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
```

- [ ] **Step 2: Adicionar o script**

In `package.json` (root), add to `scripts` after `seed:admin`:
```json
    "seed:demo": "ts-node prisma/seed-demo.ts"
```
(Ensure the preceding line ends with a comma.)

- [ ] **Step 3: Documentar `DEV_LOGIN` no `.env.example`**

In `.env.example` (root), in the "Pontos-de-plugar" / dev section near the end, add:
```bash
# ===== Apenas desenvolvimento (NUNCA em produção) =====
DEV_LOGIN=""                        # "true" habilita POST /auth/dev-login (login sem Google). Off em prod.
```

- [ ] **Step 4: Verificar que compila (o seed roda na Task 4)**

Run: `npx tsc --noEmit`
Expected: limpo (o seed usa tipos do Prisma client já gerado).

- [ ] **Step 5: Commit**

```bash
git add prisma/seed-demo.ts package.json .env.example
git commit -m "feat(dev): seed-demo (modelos ACTIVE + perfis + presença + OCUPADA) + DEV_LOGIN no env"
```

---

## Task 3: Frontend — botão dev-login

**Files:**
- Modify: `web/src/auth/auth-context.tsx` (+ `devLogin`)
- Modify: `web/src/auth/LoginPage.tsx` (botão gated)
- Modify: `web/src/auth/auth.test.tsx` (teste do botão)
- Modify: `web/.env.example` (+ VITE_DEV_LOGIN)

**Interfaces:**
- Consumes: `apiFetch<AuthResult>('/auth/dev-login', {method:'POST'})`.
- Produces: `useAuth().devLogin(): Promise<void>`; botão "Entrar como teste (dev)" na LoginPage quando `VITE_DEV_LOGIN==='true'`.

- [ ] **Step 1: Escrever o teste que falha**

In `web/src/auth/auth.test.tsx`, add a new test (and ensure imports `MemoryRouter`, `AuthProvider`, `LoginPage` are available — `LoginPage` likely needs importing). Add:
```tsx
import { LoginPage } from './LoginPage';

describe('LoginPage dev-login', () => {
  it('mostra o botão dev e chama /auth/dev-login quando VITE_DEV_LOGIN=true', async () => {
    vi.stubEnv('VITE_DEV_LOGIN', 'true');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r', user: sess.user }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter><AuthProvider><LoginPage /></AuthProvider></MemoryRouter>,
    );
    const btn = screen.getByRole('button', { name: /entrar como teste/i });
    await userEvent.click(btn);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/auth/dev-login'));
      expect(call).toBeTruthy();
      expect((call![1] as RequestInit).method).toBe('POST');
    });
    vi.unstubAllEnvs();
  });
});
```
(`sess` is the fixture already defined at the top of `auth.test.tsx`. If `MemoryRouter`/`AuthProvider` aren't imported there yet, add them to the existing imports.)

- [ ] **Step 2: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/auth/auth.test.tsx`
Expected: FAIL — botão "entrar como teste" não existe.

- [ ] **Step 3: Adicionar `devLogin` ao auth-context**

In `web/src/auth/auth-context.tsx`, add `devLogin` to the `AuthValue` interface and the value object:
- Interface: add `devLogin: () => Promise<void>;`
- In the `useMemo` value, add:
```tsx
    devLogin: async () => {
      const result = await apiFetch<AuthResult>('/auth/dev-login', { method: 'POST' });
      setSession({ accessToken: result.accessToken, refreshToken: result.refreshToken, user: result.user });
      setUser(result.user);
    },
```

- [ ] **Step 4: Adicionar o botão na LoginPage**

In `web/src/auth/LoginPage.tsx`, read the flag and pull `devLogin` from `useAuth`, and render the button. Change the `useAuth()` destructure to include `devLogin`, add near the top:
```tsx
  const devEnabled = import.meta.env.VITE_DEV_LOGIN === 'true';
```
And inside the `<div className="mt-8 ...">` block, after the Google button/fallback, add:
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
(Update `const { login } = useAuth();` → `const { login, devLogin } = useAuth();`.)

- [ ] **Step 5: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/auth/auth.test.tsx`
Expected: PASS. Then `npx vitest run` (whole suite) green.

- [ ] **Step 6: `VITE_DEV_LOGIN` no env + build + commit**

In `web/.env.example`, add:
```bash
# "true" mostra o botão "Entrar como teste (dev)". Off em produção.
VITE_DEV_LOGIN=""
```
Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/auth web/.env.example
git commit -m "feat(web): botão dev-login (gated VITE_DEV_LOGIN) + devLogin no auth-context"
```

---

## Task 4: Subir a stack + seed + verificação manual (a meta)

**Files:** nenhum (operação). Cria `web/.env` e `.env` locais (gitignored) se preciso.

- [ ] **Step 1: Containers no ar**

Run: `docker compose up -d` (Postgres dev 5432 + test 5433 + Redis). Confirme com `docker ps`.

- [ ] **Step 2: Env local do backend**

Garanta no `.env` (raiz, gitignored): `DEV_LOGIN=true` (além das vars já existentes). Não setar `NODE_ENV=production`.

- [ ] **Step 3: Schema no DB de dev + seed**

Run:
```
npx dotenv -e .env -- prisma db push
npm run seed:demo
```
Expected: schema sincronizado no DB dev; seed loga "seed-demo ok".

- [ ] **Step 4: Backend no ar**

Run (background): `npm run start:dev`. Aguarde "Nest application successfully started" (porta 3000). `curl http://localhost:3000/health` → `{status:'ok'...}`.

- [ ] **Step 5: Front**

Garanta `web/.env`: `VITE_API_URL="http://localhost:3000"`, `VITE_DEV_LOGIN="true"`. Se o dev server não estiver no ar, `cd web && npm run dev`. Anote a URL (ex.: http://localhost:5173 ou 5174).

- [ ] **Step 6: Verificar no navegador**

Abrir a URL → clicar "Entrar como teste (dev)" → cair na descoberta com 6 vozes (4 ONLINE pulsando, Sofia OCUPADA, Nina OFFLINE) → abrir um perfil → favoritar. (Se as ONLINE aparecerem OFFLINE, re-rode `npm run seed:demo` — TTL 30s — e atualize a página.)

---

## Self-Review (autor)

**Cobertura do spec:**
- §4.1 devLogin service → Task 1 Step 3. ✓
- §4.2 rota dupla-trava → Task 1 Step 4 (+ e2e on/off Step 1). ✓
- §4.3 seed-demo (modelos ACTIVE, presença, OCUPADA, idempotente) → Task 2. ✓
- §4.4 front devLogin + botão gated → Task 3. ✓
- §4.5 env (DEV_LOGIN, VITE_DEV_LOGIN) → Tasks 2/3. ✓
- §6 testes (e2e on/off + reuse; front botão) → Tasks 1/3. ✓
- §7 verificação manual → Task 4. ✓

**Consistência de tipos:** `devLogin()` retorna o shape de `/auth/google`; front `devLogin(): Promise<void>` em auth-context + LoginPage; seed cria MODEL `status:'ACTIVE'` (senão a descoberta filtra). Modelos por `provider 'dev'` + subject único (upsert idempotente), mesmo provider do CLIENT dev mas subjects distintos.

**Placeholders:** nenhum — código/comando concreto em cada passo.

**Nota de segurança:** dupla-trava (DEV_LOGIN + NODE_ENV); prod nunca seta DEV_LOGIN e roda NODE_ENV=production; e2e cobre o 404 quando desligado.
