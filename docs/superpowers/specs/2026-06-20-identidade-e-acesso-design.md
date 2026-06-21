# Spec — Subsistema Identidade & Acesso

**Data:** 2026-06-20
**Status:** Design aprovado (aguardando revisão final do usuário)
**Subsistema:** 1 de 6 do ecossistema Samy (ver `2026-06-19-ecossistema-samy-design.md` §4.1, §5)
**Depende de:** Carteira & Ledger (implementado) — usa as contas string `client:<id>`/`model:<id>` e a tabela `kyc_status`.

---

## 1. Objetivo

Construir identidade, autenticação e autorização da Samy: quem é o usuário, como ele
prova isso (login Google), como a sessão se mantém (JWT), quais papéis existem e o
mecanismo de guards que os outros subsistemas vão consumir para proteger suas ações.

Este subsistema **não** implementa as ações de cada papel (ligar, favoritar, ficar
online, sacar) — essas pertencem a Marketplace, Billing, Chamadas e Payout. Aqui se
entregam os papéis, os estados de conta e os guards.

## 2. Decisões fechadas (brainstorm)

- **Sessão:** JWT — access token curto + refresh token rotacionado e persistido (hash).
- **Login:** Google, via **porta `IdentityProvider`** com adaptador real (valida ID
  token do Google) e adaptador **fake** para testes — mesmo padrão de PSP/KYC do ledger.
- **Entrada da modelo:** **auto-cadastro + KYC, SEM convite.** O convite era curadoria
  de marca (escolha de negócio), não segurança. O KYC (Trust & Safety) é o filtro de
  entrada: modelo só fica visível/online quando `ACTIVE` (KYC aprovado). Admin pode
  suspender. Modo convite pode ser adicionado depois se a qualidade cair — fora de escopo.
- **Um papel por identidade:** uma identidade Google = um usuário = um papel. Ninguém é
  cliente e modelo ao mesmo tempo.

## 3. Constraints globais (vinculam todas as tasks)

- **Refresh token nunca é guardado em claro:** persistir apenas o hash (SHA-256). O token
  cru só existe na resposta HTTP.
- **Rotação de refresh:** todo uso de refresh revoga o token usado e emite um novo.
- **Segredos por env:** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `GOOGLE_CLIENT_ID`
  (lidos via env; em produção o boot falha se faltarem — mesmo padrão do `PSP_WEBHOOK_SECRET`).
- **TTLs por env com default:** access `ACCESS_TTL` (default 15m), refresh `REFRESH_TTL`
  (default 30d).
- **`npx tsc --noEmit` deve passar** (ts-jest não pega TS1272; usar `import type` para
  interfaces em posição injetada/decorada).
- **Dinheiro/ledger intactos:** este subsistema NÃO altera as tabelas do ledger; apenas
  passa a derivar a conta string a partir do `User.id`.
- **Conta derivada:** `CLIENT` id `U` → `client:U`; `MODEL` id `M` → `model:M`. A linha de
  `kyc_status` da modelo é chaveada por `model:M`.

## 4. Modelo de dados (Prisma)

```prisma
model User {
  id              String   @id @default(uuid())
  role            String   // CLIENT | MODEL | ADMIN
  provider        String   // "google"
  providerSubject String   // "sub" único do provedor
  email           String
  displayName     String
  status          String   // ACTIVE | PENDING_VERIFICATION | SUSPENDED
  createdAt       DateTime @default(now())

  @@unique([provider, providerSubject])
  @@index([role, status])
  @@map("users")
}

model RefreshToken {
  id        String    @id @default(uuid())
  userId    String
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
  @@map("refresh_tokens")
}
```

Sem migração interativa: gerar via `prisma migrate diff` + `prisma migrate deploy`
(o `prisma migrate dev` trava no runtime não-interativo); o banco de teste recebe o
schema via `db:test:push` que o `npm run test:int` já roda.

## 5. Componentes (arquitetura)

```
identity/
  identity.port.ts        IdentityProvider (porta) + IDENTITY_PROVIDER token
                          verify(idToken): Promise<{ provider, subject, email, name }>
  google-identity.adapter.ts   adaptador real (valida ID token Google via GOOGLE_CLIENT_ID)
  fake-identity.adapter.ts     adaptador de teste (mapa idToken -> claims)
  identity.module.ts

users/
  users.service.ts        findByProvider, createUser, findById, setStatus
  users.module.ts

auth/
  auth.service.ts         loginOrRegister(idToken, role), refresh(token), logout(token)
  token.service.ts        assina/verifica access JWT; cria/rotaciona/revoga refresh (hash)
  auth.controller.ts      POST /auth/google, /auth/refresh, /auth/logout; GET /auth/me
  jwt-auth.guard.ts       valida access JWT -> injeta req.user
  roles.guard.ts + roles.decorator.ts   @Roles('ADMIN') etc.
  auth.module.ts

admin/
  admin.controller.ts     POST /admin/users/:id/activate, /admin/users/:id/suspend  (@Roles ADMIN)
```

Cada arquivo com uma responsabilidade só; `TokenService` isola toda a criptografia de
token para ser testado isolado.

## 6. Fluxos

### 6.1 Login/cadastro (`POST /auth/google`)
Body: `{ idToken: string, role?: 'CLIENT' | 'MODEL' }` (role só usado na criação).
1. `IdentityProvider.verify(idToken)` → `{ provider:'google', subject, email, name }`.
   Token inválido → 401.
2. `UsersService.findByProvider('google', subject)`.
3. **Existe** → é login. Ignora o `role` do body; usa o papel já gravado. Se
   `status === SUSPENDED` → 403.
4. **Não existe** → cria usuário:
   - `role` ausente ou `CLIENT` → CLIENT, status `ACTIVE`.
   - `role === 'MODEL'` → MODEL, status `PENDING_VERIFICATION`.
   - `role === 'ADMIN'` via cadastro → **proibido** (400); admin só por seed.
5. Emite par de tokens (access JWT + refresh persistido por hash). Retorna
   `{ accessToken, refreshToken, user: { id, role, status, email, displayName } }`.

Conflito de papel: como o passo 3 sempre usa o papel existente, uma identidade nunca
vira dois papéis. Quem é CLIENT e tenta `role:'MODEL'` simplesmente loga como CLIENT.

### 6.2 Refresh (`POST /auth/refresh`)
Body `{ refreshToken }`. Calcula hash, busca em `refresh_tokens`. Inválido / expirado /
`revokedAt != null` → 401. Senão: marca `revokedAt = now` no antigo, emite novo par
(rotação), retorna. Usuário SUSPENDED → 401 (e revoga).

### 6.3 Logout (`POST /auth/logout`)
Body `{ refreshToken }`. Marca `revokedAt = now`. Idempotente (token já revogado/ausente
→ 200 mesmo assim, sem vazar existência).

### 6.4 Me (`GET /auth/me`)
`JwtAuthGuard` valida o access token e injeta `req.user`. Retorna o usuário atual
(busca por id para refletir status corrente). SUSPENDED → 403.

### 6.5 Admin (`POST /admin/users/:id/activate|suspend`)
`JwtAuthGuard` + `RolesGuard('ADMIN')`. `activate` → status `ACTIVE` (usado pelo admin
e, futuramente, pelo Trust & Safety ao aprovar KYC). `suspend` → status `SUSPENDED`.
Usuário inexistente → 404.

## 7. Guards entregues aos outros subsistemas

- `JwtAuthGuard` — exige access JWT válido; injeta `req.user = { id, role, status }`.
- `@Roles(...roles)` + `RolesGuard` — exige papel; 403 se não bater.
- O `status` em `req.user` permite a outros subsistemas impor regras (ex.: Marketplace
  lista só modelo `ACTIVE`; Chamadas barra `SUSPENDED`).

## 8. Tratamento de erros

- 401: token de identidade inválido; access/refresh inválido/expirado/revogado.
- 403: usuário SUSPENDED; papel insuficiente no `RolesGuard`.
- 400: tentativa de cadastro com `role:'ADMIN'`; payload malformado.
- 404: admin agindo sobre usuário inexistente.
- Segredos ausentes no boot (produção) → falha de inicialização (não silenciar com default).

## 9. Testes (integração, contra Postgres real + FakeIdentityProvider)

1. Cadastro de CLIENT cria usuário ACTIVE e retorna par de tokens.
2. Cadastro de MODEL cria usuário PENDING_VERIFICATION.
3. Login de identidade já existente retorna o papel gravado e ignora o `role` do body
   (CLIENT que tenta `role:'MODEL'` continua CLIENT).
4. `role:'ADMIN'` no cadastro é rejeitado (400).
5. Refresh válido rotaciona: novo par emitido, token antigo fica revogado e não funciona
   numa segunda tentativa (401).
6. Refresh com token revogado/expirado/inexistente → 401.
7. Logout revoga o refresh; refresh subsequente → 401; logout repetido → 200.
8. `GET /auth/me` com access válido retorna o usuário; sem token → 401.
9. Usuário SUSPENDED: `/auth/me` → 403; refresh → 401.
10. `RolesGuard`: endpoint admin com usuário CLIENT → 403; com ADMIN → 200.
11. Admin activate/suspend muda o status; usuário inexistente → 404.
12. `TokenService` (unitário): refresh é persistido por hash, nunca em claro; access JWT
    assinado/verificado com o segredo correto e rejeitado com segredo errado.

## 10. Fora de escopo (follow-up / outros subsistemas)

- Verificação KYC real (liveness/documento) e o que dispara `activate` automaticamente
  → Trust & Safety (subsistema 6). Aqui o admin ativa manualmente.
- Modo "convite" para a entrada de modelos (se a qualidade exigir no futuro).
- Adaptador Google real exercitado ponta-a-ponta (precisa de front + credenciais OAuth);
  o subsistema entrega a porta + adaptador, validados via fake nos testes.
- Capacidades por papel (ligar, favoritar, ficar online, sacar) — subsistemas próprios.
- Rate limiting / proteção a brute force nos endpoints de auth → hardening posterior.
```
