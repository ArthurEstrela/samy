# Spec — Subsistema Marketplace & Descoberta

**Data:** 2026-06-20
**Status:** Design aprovado (aguardando revisão final do usuário)
**Subsistema:** 4 de 6 do ecossistema Samy (blueprint §4.5).
**Depende de:** Identidade & Acesso (papéis CLIENT/MODEL, guards `JwtAuthGuard`/`RolesGuard`, `User.status`, `accountOf`). KYC (a modelo só vira `ACTIVE` após aprovação — e só ACTIVE aparece na descoberta). Introduz **Redis** no stack.

---

## 1. Objetivo e escopo

A vitrine da Samy: a modelo monta seu **perfil** (preço/min, tags, bio, preview de voz),
fica **online** em tempo real, e o cliente **descobre/filtra/favorita** modelos. É o
"rosto" do produto e o gancho de escassez (bolinha verde) do pitch.

**No escopo:**
- **Perfil da modelo** (1:1 com o User MODEL): bio, preço/min, tags, `voicePreviewUrl`.
- **Presença em tempo real** via Redis + heartbeat: `ONLINE` / `OFFLINE`.
- **Descoberta**: listagem de modelos ACTIVE com perfil, filtro por tags, ordenação
  online-first → favoritas → recentes, com `isOnline`/`isFavorite` por cliente.
- **Favoritos**: cliente favorita/desfavorita e lista suas favoritas.

**Fora de escopo (outros subsistemas / follow-up):**
- Estado **OCUPADA** — depende do subsistema de Chamadas (por ora só ONLINE/OFFLINE).
- **Ranking por performance** (quem fatura/converte mais) — precisa de dados de chamada.
- **Pipeline de upload de áudio** (object storage / URLs pré-assinadas / CDN) — o perfil
  guarda só uma `voicePreviewUrl`; como o arquivo chega lá é follow-up próprio.
- Notificação de "ficou online" pra fila — depende de presença + Chamadas; follow-up.

## 2. Decisões fechadas (brainstorm)

- **Redis entra agora** para presença (heartbeat com TTL). É onde o Redis genuinamente se
  paga; passa a existir no stack para usos futuros (cache de status, grace de refresh, etc.).
- **Preview de voz = campo `voicePreviewUrl` agora; upload deferido.** A lógica do
  marketplace não depende do mecanismo de upload; o campo deixa o preview a um passo de
  funcionar quando o storage existir, sem retrabalho.
- **Visibilidade pela ACTIVE:** só modelo `User.status = ACTIVE` E com `ModelProfile`
  aparece na descoberta — amarra com o KYC (PENDING não aparece).

## 3. Constraints globais (vinculam todas as tasks)

- **Presença NÃO vive no Postgres** — só no Redis, com TTL. Parar o heartbeat → OFFLINE
  automático em segundos (não existe "online preso").
- **Heartbeat TTL = 30s**, recomendado bater a cada ~20s. Chave `presence:model:<userId>`.
- **`REDIS_URL` por env, fail-fast no boot** se ausente (mesmo padrão dos outros segredos).
- **`pricePerMinute` é `Decimal(14,2)` e deve ser > 0.** Nunca float em aritmética monetária.
- **`voicePreviewUrl`, se presente, é uma URL http(s) válida** (validada na escrita).
- **Conta da modelo:** `model:<userId>` via `accountOf` (consistência com ledger/KYC).
- **Descoberta retorna `isOnline` e `isFavorite`** calculados para o usuário requisitante.
- **Listagem tem limite** (default 50, máx 100) — sem lista ilimitada.
- **`npx tsc --noEmit` deve passar:** `import type` para interfaces em posição injetada (TS1272).
- **Migração não-interativa:** `prisma migrate diff` + `prisma migrate deploy`; SQL em UTF-8
  sem BOM; banco de teste via `db:test:push`. **Append em `.env` sempre com newline inicial**
  (lição do KYC: append sem newline cola na linha anterior e corrompe o valor).
- **Não alterar tabelas do ledger/identidade/kyc.**

## 4. Modelo de dados (Prisma)

```prisma
model ModelProfile {
  userId          String   @id            // o User MODEL dono do perfil (1:1)
  bio             String?
  pricePerMinute  Decimal  @db.Decimal(14, 2)
  tags            String[]                // filtro de descoberta (Postgres text[])
  voicePreviewUrl String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([pricePerMinute])
  @@map("model_profiles")
}

model Favorite {
  id           String   @id @default(uuid())
  clientUserId String
  modelUserId  String
  createdAt    DateTime @default(now())

  @@unique([clientUserId, modelUserId])
  @@index([clientUserId])
  @@map("favorites")
}
```

Presença não tem tabela (Redis). Sem FK (consistente com o padrão string-loose do projeto).

## 5. Infra Redis

- **docker-compose:** serviço `redis` (`redis:7`), porta 6379 (e um índice/porta separada
  para teste, ou um segundo container `redis_test`). `REDIS_URL` em `.env` e `.env.test`.
- **`RedisModule` (`@Global`) + `RedisService`** — wrapper fino sobre `ioredis`:
  - `setOnline(modelId: string): Promise<void>` — `SET presence:model:<id> ONLINE EX 30`.
  - `getStatuses(modelIds: string[]): Promise<Record<string, 'ONLINE' | 'OFFLINE'>>` —
    `MGET` das chaves; presente → ONLINE, ausente → OFFLINE.
  - `getStatus(modelId: string): Promise<'ONLINE' | 'OFFLINE'>`.
  - lifecycle: conecta no `onModuleInit`, desconecta no `onModuleDestroy`; construtor
    fail-fast se `REDIS_URL` ausente.

## 6. Componentes

```
redis/
  redis.service.ts        wrapper ioredis (setOnline, getStatus(es))
  redis.module.ts         @Global
marketplace/
  presence.service.ts     heartbeat(modelId), getStatus(es) — usa RedisService
  profile.service.ts      upsert(userId, dto), getOwn(userId), getPublic(userId)
  favorites.service.ts    favorite/unfavorite(clientId, modelId), listFavoriteModelIds(clientId)
  discovery.service.ts    list({tags?, limit?}, clientId) -> ModelCard[]
  profile.controller.ts   PUT/GET /me/profile (MODEL); GET /models/:id (auth)
  presence.controller.ts  POST /me/heartbeat (MODEL)
  discovery.controller.ts GET /models (auth)
  favorites.controller.ts POST/DELETE /favorites/:modelId, GET /favorites (CLIENT)
  marketplace.module.ts
```

Reusa: `AuthModule` (guards), `PrismaModule`, `UsersService.accountOf`, `RedisModule`.

## 7. Fluxos

### 7.1 Perfil (`PUT /me/profile`, MODEL)
Body `{ bio?, pricePerMinute, tags?, voicePreviewUrl? }`. Valida `pricePerMinute > 0`
(400 se não); `voicePreviewUrl` http(s) válida se presente (400 se não). Upsert por
`userId = req.user.id`. `GET /me/profile` devolve o próprio (404 se não criou).

### 7.2 Heartbeat (`POST /me/heartbeat`, MODEL)
`RedisService.setOnline(req.user.id)` → presença com TTL 30s. Retorna `{ status: 'ONLINE', ttl: 30 }`.

### 7.3 Descoberta (`GET /models?tags=a,b&limit=`, autenticado)
1. Query Postgres: Users `role=MODEL`, `status=ACTIVE`, com `ModelProfile`; se `tags`
   informado, perfil deve conter todas as tags (`hasEvery`); aplica `limit` (default 50, máx 100).
2. `RedisService.getStatuses(ids)` para os candidatos (um MGET).
3. Se o requisitante é CLIENT: `FavoritesService.listFavoriteModelIds(clientId)` para marcar
   `isFavorite`.
4. Ordena: **ONLINE antes de OFFLINE → favoritas antes → `createdAt` desc**.
5. Retorna `ModelCard[]`: `{ userId, displayName, bio, pricePerMinute, tags, voicePreviewUrl, isOnline, isFavorite }`.

### 7.4 Modelo único (`GET /models/:id`, autenticado)
Perfil público da modelo (404 se não existe / não é ACTIVE-com-perfil) + `isOnline` (+ `isFavorite` se CLIENT).

### 7.5 Favoritos (CLIENT)
- `POST /favorites/:modelId` — cria favorito (idempotente: se já existe, 200/204 sem erro). 404 se o alvo não é um MODEL existente.
- `DELETE /favorites/:modelId` — remove (idempotente).
- `GET /favorites` — lista os `ModelCard` das favoritas do cliente (com isOnline).

## 8. Tratamento de erros

- 401: sem token nos endpoints autenticados.
- 403: CLIENT em endpoint MODEL (perfil/heartbeat); MODEL em endpoint CLIENT (favoritos).
- 400: `pricePerMinute <= 0`; `voicePreviewUrl` inválida; `limit` fora do range.
- 404: `/me/profile` sem perfil; `/models/:id` inexistente/não-ACTIVE; favoritar um modelId que não é MODEL.
- Boot falha se `REDIS_URL` ausente.

## 9. Testes (integração, contra Postgres real + Redis de teste real)

1. `PUT /me/profile` cria/atualiza; `GET /me/profile` devolve; sem perfil → 404.
2. Validação: `pricePerMinute <= 0` → 400; `voicePreviewUrl` inválida → 400.
3. CLIENT em `PUT /me/profile` → 403; sem token → 401.
4. Heartbeat seta presença (status ONLINE); após expirar/limpar a chave → OFFLINE.
5. Descoberta lista só modelos ACTIVE com perfil (PENDING ou sem-perfil não aparecem).
6. Filtro por tags retorna só quem tem todas as tags pedidas.
7. Ordenação: modelo ONLINE aparece antes de OFFLINE; entre online, favorita antes de não-favorita.
8. `isFavorite` reflete os favoritos do cliente requisitante.
9. Favoritar/desfavoritar (idempotente); `GET /favorites` lista; favoritar não-MODEL → 404.
10. MODEL em `POST /favorites/:id` → 403.
11. `GET /models/:id` ACTIVE → perfil + isOnline; inexistente/PENDING → 404.
12. `limit` respeitado (default e máximo).
13. `RedisService` (integração): `setOnline` + `getStatuses` refletem presença; chave expira.

## 10. Sequência de implementação (sugerida)
Infra Redis (compose + RedisService + env) → schema (ModelProfile, Favorite) →
ProfileService+controller → PresenceService+heartbeat → FavoritesService+controller →
DiscoveryService+controller (junta tudo) → suíte completa.
