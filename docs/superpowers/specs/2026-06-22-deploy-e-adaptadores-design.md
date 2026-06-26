# Spec — Pronto pra Deploy + Adaptadores sem-credencial

**Data:** 2026-06-22
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Infra de produção + hardening + adaptadores construíveis sem credencial externa.
**Depende de:** Todos os 6 subsistemas do backend (completos). Não muda lógica de negócio; empacota, blinda e prepara pra plugar chaves.

---

## 1. Objetivo e escopo

Transformar o backend testado num artefato **deployável** e **seguro pra produção**, e
fechar os adaptadores reais que NÃO dependem de conta em provedor externo. O resto
(PSP/KYC) fica como ponto-de-plugar documentado.

**No escopo:**
- **Containerização** host-agnóstica: `Dockerfile` multi-stage + `docker-compose.prod.yml`
  (app + Postgres + Redis), entrypoint que roda `prisma migrate deploy`.
- **`.env.example`** documentando TODAS as variáveis de ambiente do sistema.
- **Hardening do boot:** porta via env, shutdown gracioso, `helmet`, CORS configurável,
  e `GET /health` (checa Postgres + Redis).
- **Adaptador LiveKit real** (`livekit-server-sdk`) para o `MEDIA_SERVER` — assina token de
  sala; boota sem chaves (falha só ao emitir).
- **Auditoria de segurança de produção:** nenhum adaptador *fake* pode ser o default em
  produção. Trocar o default do `PSP_PAYOUT_PORT` de `FakePspPayoutPort` para um
  `RealPspPayoutPort` stub que lança "not configured" (fake só nos testes).
- **README de deploy** com o passo-a-passo.

**Fora de escopo (follow-up / outras frentes):**
- Wiring HTTP específico de **PSP** (cash-out) e **KYC** — depende do provedor escolhido +
  docs/chaves. Ficam como stubs que lançam erro claro, documentados.
- **Criação de cobrança PIX/QR no cash-in** — gap de feature (precisa do PSP). Hoje o
  cash-in é só via webhook de confirmação.
- **Agendadores** (cron do taxímetro / processador de saques) — outra frente.
- **CI/CD**, observabilidade/métricas, configs de plataforma gerenciada (Railway/Fly).

## 2. Decisões fechadas (brainstorm)

- **Sem contas em provedor ainda** → construir só o que não exige credencial; PSP/KYC viram
  shells documentados.
- **Host-agnóstico (Docker + compose)** em vez de amarrar a uma plataforma gerenciada —
  roda em qualquer VPS, e o usuário não precisa de conta em lugar nenhum pra testar.
- **Boota sem credencial:** adaptadores reais (LiveKit, PSP, KYC) NÃO exigem env no
  construtor — falham com erro claro só quando usados. Isso permite subir a imagem antes de
  ter as chaves.
- **Segurança > conveniência:** o default de produção de toda porta externa é o adaptador
  real (ou um stub que lança), NUNCA um fake. Fakes só via `.overrideProvider` nos testes.

## 3. Constraints globais (vinculam todas as tasks)

- **App boota sem nenhuma chave de provedor** (LiveKit/PSP/KYC). Só os segredos já exigidos
  hoje (JWT/Google/secrets de webhook/GLOBAL_TAKE_RATE/DATABASE_URL/REDIS_URL) são fail-fast.
- **`GET /health`** retorna 200 só se Postgres E Redis respondem; senão 503.
- **Nenhum `Fake*` adapter é o default de um módulo de produção** — auditável no código.
- **`import type` em interfaces injetadas;** `npx tsc --noEmit` limpo.
- **Migração em produção** via `prisma migrate deploy` no entrypoint do container (não
  `db push`, não `migrate dev`).
- **Não alterar lógica de negócio** dos 6 subsistemas — só infra, boot, e troca de defaults.
- **Imagem runtime enxuta** (sem devDependencies; só `dist/`, `node_modules` de produção,
  `prisma/`).
- **A suíte de integração continua verde** após as mudanças (defaults trocados, mas testes
  usam override do fake).

## 4. Componentes

```
Dockerfile                     multi-stage (build + runtime), entrypoint roda migrate deploy
docker-compose.prod.yml        app + postgres + redis (volumes, healthchecks, restart)
.env.example                   todas as env vars documentadas (sem valores reais)
README-deploy.md               passo-a-passo (build, env, up, migrate, health)
src/main.ts                    (modificado) helmet, CORS, shutdown hooks, port via env
src/health/health.controller.ts  GET /health (Postgres + Redis)
src/health/health.module.ts
src/calls/livekit-media-server.adapter.ts  (substituído) real via livekit-server-sdk
src/payout/real-psp-payout.adapter.ts      (novo) stub que lança 'not configured'
src/payout/payout.module.ts    (modificado) default = RealPspPayoutPort (fake só em teste)
```

## 5. Detalhes

### 5.1 Dockerfile (multi-stage)
- **build:** `node:22-slim`, `npm ci`, `npx prisma generate`, `npm run build` (nest build → `dist/`).
- **runtime:** `node:22-slim`, copia `dist/`, `node_modules` (prod), `prisma/`, `package.json`.
  Entrypoint: `npx prisma migrate deploy && node dist/main.js`.
- `EXPOSE 3000`; usuário non-root.

### 5.2 docker-compose.prod.yml
- `postgres:16` (volume persistente, healthcheck `pg_isready`), `redis:7` (healthcheck `redis-cli ping`),
  `app` (build do Dockerfile, `depends_on` healthy, `env_file: .env`, `restart: unless-stopped`,
  porta `3000`).

### 5.3 Boot hardening (`main.ts`)
- `app.enableShutdownHooks()` (Prisma/Redis desconectam no SIGTERM).
- `app.use(helmet())`.
- `app.enableCors({ origin: process.env.CORS_ORIGIN ?? true })`.
- `app.listen(process.env.PORT ?? 3000)`.
- mantém `{ rawBody: true }` (webhooks HMAC dependem disso).

### 5.4 `GET /health`
- `HealthController` injeta `PrismaService` + `RedisService`. Faz `SELECT 1` e um `ping`
  no Redis. Tudo ok → 200 `{ status:'ok', postgres:'up', redis:'up' }`; qualquer falha →
  503 (`ServiceUnavailableException`). Sem guard (público — pra load balancer/uptime check).

### 5.5 Adaptador LiveKit real
- `LivekitMediaServer.issueToken(roomName, identity)`: usa `AccessToken` do
  `livekit-server-sdk` com `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, concede `roomJoin` na
  `roomName` com a `identity`, retorna `{ token: jwt, url: LIVEKIT_URL }`.
- Construtor NÃO exige env; lê as chaves em `issueToken` e lança
  `Error('LiveKit not configured')` se faltarem (boota sem chaves; testes usam o fake).

### 5.6 Auditoria: PSP payout default
- Criar `RealPspPayoutPort` (`sendPix` lança `Error('PSP payout not configured')`).
- `PayoutModule`: trocar `{ provide: PSP_PAYOUT_PORT, useClass: FakePspPayoutPort }` por
  `useClass: RealPspPayoutPort`. Os testes do payout que usam o fake passam a fazer
  `.overrideProvider(PSP_PAYOUT_PORT).useClass(FakePspPayoutPort)` (ajuste nos testes).

### 5.7 `.env.example` (todas as vars)
`DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `ACCESS_TTL`,
`REFRESH_TTL`, `GOOGLE_CLIENT_ID`, `PSP_WEBHOOK_SECRET`, `KYC_WEBHOOK_SECRET`,
`GLOBAL_TAKE_RATE`, `MIN_PAYOUT`, `PORT`, `CORS_ORIGIN`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `LIVEKIT_URL`. Cada uma com comentário do que é + se é obrigatória no
boot ou só ao usar a feature. Marcar os pontos-de-plugar de PSP/KYC.

## 6. Tratamento de erros
- App sobe mesmo sem `LIVEKIT_*`/PSP/KYC config — só falha ao usar a feature, com mensagem clara.
- `/health` → 503 se Postgres ou Redis cair.
- Boot ainda falha (fail-fast) se faltar `JWT_*`, `GOOGLE_CLIENT_ID`, `PSP_WEBHOOK_SECRET`,
  `KYC_WEBHOOK_SECRET`, `GLOBAL_TAKE_RATE`, `DATABASE_URL`, `REDIS_URL` (comportamento atual,
  mantido).

## 7. Testes
- **Código (Jest):** `GET /health` retorna 200 com Postgres+Redis up (e2e); `LivekitMediaServer`
  emite um token JWT contendo a room/identity dado `LIVEKIT_*` de teste, e lança claro sem as
  chaves (unit); a suíte de payout continua verde com o override do fake.
- **Infra (manual, documentado no README):** `docker build` da imagem; `docker compose -f
  docker-compose.prod.yml up`; confirmar `migrate deploy` rodou e `GET /health` → 200. Não é
  Jest — infra de container se verifica buildando/rodando.
- A **suíte completa** (`npm run test:int`) permanece verde após a troca dos defaults.

## 8. Sequência de implementação (sugerida)
`/health` (controller + módulo + teste) → hardening do main.ts (helmet/CORS/shutdown/port) →
LiveKit real adapter (+ env exemplo das LIVEKIT_*) → RealPspPayoutPort + troca de default
(+ ajuste dos testes de payout) → Dockerfile + docker-compose.prod.yml + .env.example +
README → rodar a suíte completa + build da imagem.
