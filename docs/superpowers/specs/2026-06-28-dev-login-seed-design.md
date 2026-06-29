# Spec — Dev-login + Seed de demo (só desenvolvimento)

**Data:** 2026-06-28
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Utilitário de desenvolvimento — permite testar o app local sem Google.
**Depende de:** Auth (TokenService/AuthService/UsersService), Marketplace (discovery), Frontend (LoginPage/auth-context).

---

## 1. Objetivo e escopo

Permitir logar com 1 clique (sem Google) e ter vozes de teste na vitrine, **apenas em
desenvolvimento**, pra andar pelo app (descoberta/perfil/favoritar) localmente.

**No escopo:**
- Backend: `AuthService.devLogin()` + rota `POST /auth/dev-login` com dupla-trava de ambiente.
- Seed: `prisma/seed-demo.ts` + `npm run seed:demo` (modelos ACTIVE + perfis + presença/ocupada).
- Frontend: botão "Entrar como teste (dev)" na `LoginPage` (gated por `VITE_DEV_LOGIN`) + `devLogin()` no `auth-context`.
- Env: `DEV_LOGIN` (backend) e `VITE_DEV_LOGIN` (front), documentados como dev-only.

**Fora de escopo:** qualquer caminho de login alternativo em produção; cadastro de modelo pelo
front; persistência de presença além do TTL de 30s (re-rodar o seed reacende as ONLINE).

## 2. Constraints globais (segurança em primeiro lugar)

- **`POST /auth/dev-login` só responde quando `process.env.DEV_LOGIN === 'true'` E
  `process.env.NODE_ENV !== 'production'`.** Caso contrário → `404 NotFound` (como se a rota não
  existisse). A checagem é feita no próprio handler (não só no wiring).
- **Produção (docker-compose.prod) nunca seta `DEV_LOGIN`** → endpoint desligado. O `.env.example`
  do backend documenta `DEV_LOGIN` como dev-only (default ausente/`false`). O Dockerfile roda com
  `NODE_ENV=production`, então a segunda trava também protege mesmo se `DEV_LOGIN` vazar.
- O `devLogin()` cria/usa um **CLIENT** fixo (`provider 'dev'`, `subject 'dev-client'`,
  `email 'dev@samy.local'`, `displayName 'Cliente Dev'`, role CLIENT, status ACTIVE) e devolve o
  **mesmo shape** do `/auth/google`: `{ accessToken, refreshToken, user }`.
- **Seed cria modelos com `status: 'ACTIVE'`** via Prisma direto (o `createUser` poria MODEL como
  `PENDING_VERIFICATION`, que a descoberta filtra fora). Idempotente (upsert por provider+subject).
- `import type` em interfaces injetadas; `npx tsc --noEmit` limpo (backend) / `npm run build` limpo (front).
- Não alterar lógica de negócio existente; só adicionar o endpoint/seed/botão.

## 3. Componentes

```
src/auth/auth.service.ts        + devLogin(): Promise<AuthResult>          [mod]
src/auth/auth.controller.ts     + POST /auth/dev-login (dupla-trava env)   [mod]
prisma/seed-demo.ts             cria modelos+perfis+presença/ocupada       [novo]
package.json (raiz)             + script "seed:demo"                       [mod]
.env.example (raiz)             + DEV_LOGIN (dev-only)                     [mod]
web/src/auth/auth-context.tsx   + devLogin()                              [mod]
web/src/auth/LoginPage.tsx      + botão dev (gated VITE_DEV_LOGIN)         [mod]
web/.env.example                + VITE_DEV_LOGIN                          [mod]
test/auth.dev-login.e2e-spec.ts e2e do endpoint (on/off)                  [novo]
web/src/auth/auth.test.tsx      + teste do botão/devLogin                 [mod]
```

## 4. Detalhes

### 4.1 Backend — `AuthService.devLogin()`
```ts
async devLogin(): Promise<{ accessToken; refreshToken; user }> {
  const provider = 'dev', subject = 'dev-client';
  let user = await this.users.findByProvider(provider, subject);
  if (!user) {
    user = await this.users.createUser({ role: 'CLIENT', provider, subject, email: 'dev@samy.local', name: 'Cliente Dev' });
  }
  const refreshToken = await this.tokens.issueRefresh(user.id);
  return { accessToken: this.tokens.signAccess({ id: user.id, role: user.role }), refreshToken, user: { id, role, status, email, displayName } };
}
```
(role CLIENT → createUser já gera status ACTIVE.)

### 4.2 Backend — rota
`@Post('dev-login')` no `AuthController`:
```ts
if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') {
  throw new NotFoundException();
}
return this.auth.devLogin();
```

### 4.3 Seed `prisma/seed-demo.ts`
- Cria/atualiza (upsert) um CLIENT dev e ~6 MODELS (`status:'ACTIVE'`) com `ModelProfile`
  (stageName, pricePerMinute, tags, bio variados, voicePreviewUrl null).
- Presença: conecta no Redis (`REDIS_URL` do `.env`) e seta `presence:model:<id>` = `ONLINE` EX 30
  pra ~4 modelos. Cria 1 `Call` `ACTIVE` (cliente dev × 1 modelo) → esse vira **OCUPADA** (persiste).
  1 modelo fica **OFFLINE** (sem presença).
- Idempotente: re-rodar atualiza dados e reacende as ONLINE (TTL 30s). Loga um resumo.
- `npm run seed:demo` = `ts-node prisma/seed-demo.ts` (carrega `.env`).

### 4.4 Frontend
- `auth-context`: `devLogin: () => Promise<void>` → `apiFetch<AuthResult>('/auth/dev-login', {method:'POST'})` → `setSession` + `setUser`.
- `LoginPage`: se `import.meta.env.VITE_DEV_LOGIN === 'true'`, renderiza um botão secundário
  "Entrar como teste (dev)" que chama `devLogin()` e navega pra `/`. Estilo discreto (borda mist),
  separado do Google.

### 4.5 Env
- Backend `.env` (local): `DEV_LOGIN=true`, `NODE_ENV=development` (ou ausente). `.env.example`:
  `DEV_LOGIN=""` com comentário "dev-only; NUNCA em produção".
- Front `web/.env` (local): `VITE_DEV_LOGIN=true`. `web/.env.example`: `VITE_DEV_LOGIN=""`.

## 5. Tratamento de erros
- `dev-login` desligado → `404` (não vaza que existe). Front: se `VITE_DEV_LOGIN` não for `true`, o
  botão nem aparece; se aparecer mas o backend recusar (404), o erro é exibido/logado.
- Seed sem Redis no ar → loga aviso e segue (os modelos ficam OFFLINE; cria mesmo assim).

## 6. Testes
- **`test/auth.dev-login.e2e-spec.ts`:** com `DEV_LOGIN=true` → `POST /auth/dev-login` 201 devolve
  `{accessToken, refreshToken, user.role==='CLIENT'}`; com `DEV_LOGIN` desativado → `404`. (Toggla
  `process.env.DEV_LOGIN` por teste.)
- **Front `auth.test.tsx`:** com `VITE_DEV_LOGIN` mockado true, o botão "Entrar como teste" aparece
  e clicar chama `devLogin` (fetch `/auth/dev-login` POST) → popula user. (Stub do `import.meta.env`.)
- Suíte backend e `npm run build` do front permanecem verdes.

## 7. Verificação manual (a meta)
Subir containers → `dotenv -e .env -- prisma db push` (schema no DB dev) → `npm run seed:demo` →
`npm run start:dev` (backend) → front já no ar → abrir, clicar "Entrar como teste", ver a
descoberta com vozes (algumas pulsando) e abrir um perfil.

## 8. Sequência de implementação (sugerida)
devLogin (service+rota+e2e) → seed-demo + script → front (devLogin + botão + teste + env) →
subir a stack + seed + verificação manual.
