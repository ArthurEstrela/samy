# Spec — Subsistema Motor de Chamadas

**Data:** 2026-06-22
**Status:** Design aprovado (aguardando revisão final do usuário)
**Subsistema:** 5 de 6 do ecossistema Samy (blueprint §4.4).
**Depende de:** Identidade & Acesso (papéis/guards), Carteira & Ledger (`getBalance` — gate de crédito), Marketplace (`ModelProfile.pricePerMinute`; presença ONLINE via `RedisService`). Habilita o **Billing Engine** (subsistema 6, que tarifa as chamadas ATIVAS).

---

## 1. Objetivo e escopo

A orquestração das chamadas de voz: o cliente liga para uma modelo online, ela atende, os
dois entram numa sala de mídia, e qualquer lado (ou o pânico, ou o fim do crédito) encerra.
Este subsistema é o **ciclo de vida + as regras** da chamada; a mídia em tempo real entra por
uma porta, e a tarifação é do Billing.

**No escopo:**
- Entidade `Call` + máquina de estados (REQUESTED → ACTIVE → ENDED, com motivos).
- Semântica **ring/accept**: cliente liga (toca), modelo aceita/rejeita, ou expira (timeout).
- **Gate de início** (modelo chamável + cliente com saldo) com **blindagem de concorrência**.
- **Token de sala de mídia via porta** (`MediaServerProvider`: fake p/ teste, LiveKit stub real).
- **Encerramento**: hangup (qualquer lado), **pânico** (modelo), `endCall(NO_CREDITS)` (Billing).
- **OCUPADA na descoberta**: o Marketplace passa a mostrar `ONLINE|OCUPADA|OFFLINE`.
- Registro de tempos (`startedAt`/`endedAt`) + `pricePerMinuteSnapshot` para o Billing.

**Fora de escopo (outros subsistemas / follow-up):**
- **Fluxo de mídia WebRTC real / SFU** → adaptador LiveKit real + frontend (porta agora).
- **Taxímetro / cobrança por minuto** → Billing Engine (subsistema 6). Aqui só o seam (`endCall`, tempos, snapshot de preço).
- **Bloqueio por CPF / score de risco** → metade "abuso" do Trust & Safety.
- **Fila "avise quando ficar online"** → presença + notificações.
- **Reaper agendado de timeout** → cron futuro; por ora o timeout é lazy (na leitura/accept).

## 2. Decisões fechadas (brainstorm)

- **Ring/accept** (toca e a modelo atende), não auto-connect — dá consentimento/controle à modelo a cada chamada.
- **Invariante de integridade financeira:** um cliente tem **no máximo UMA chamada não-encerrada** por vez; uma modelo idem. Imposto via **advisory lock** (`pg_advisory_xact_lock`, mesmo padrão do saque) no `POST /calls` E re-checado no `accept`. Fecha o TOCTOU das duas abas (saldo cobre 1, dois accepts simultâneos).
- **Advisory lock, não índice único parcial:** Prisma v5 não declara índice parcial e o banco de teste recebe schema via `db push` (ignora SQL cru) — advisory lock funciona idêntico em dev/teste.
- **OCUPADA é derivada** da existência de uma `Call` ACTIVE (não um valor no Redis) — evita "ocupada presa" se o heartbeat e a chamada brigarem.
- **Sem ciclo de dependência:** Calls usa `RedisService` (`@Global`) e lê `ModelProfile` via Prisma; **não importa MarketplaceModule**. O Marketplace importa o CallsModule (Marketplace → Calls, mão única).
- **Mídia por porta**, captura/fluxo no SFU — backend só emite tokens de sala.

## 3. Constraints globais (vinculam todas as tasks)

- **No máximo uma chamada não-ENDED por cliente e por modelo** — imposto com advisory lock por entidade dentro da transação (locks adquiridos em ordem determinística do valor da chave, evitando deadlock).
- **Re-check atômico no accept:** sob advisory lock do cliente, dentro de `$transaction`: a chamada ainda é REQUESTED e não expirou; o cliente não tem OUTRA ACTIVE; `saldo >= pricePerMinuteSnapshot`. Falhou → `ENDED` (motivo apropriado), accept responde erro.
- **Gate de início:** modelo `role=MODEL` + `status=ACTIVE` + tem `ModelProfile` + presença `ONLINE` + sem chamada aberta; cliente `saldo >= pricePerMinute` (≥ 1 minuto) + sem chamada aberta.
- **`pricePerMinuteSnapshot`** capturado no REQUESTED (Decimal(14,2)); o Billing usa esse valor, não o preço corrente (que a modelo pode mudar no meio).
- **Token de mídia emitido sob demanda** (no accept p/ a modelo; no `GET /calls/:id` p/ cada participante) — credencial curta, não fica "guardada" como segredo persistente além do necessário.
- **Timeout lazy:** `REQUESTED` com idade > `RING_TIMEOUT_SECONDS = 30` é transicionada para `ENDED(TIMEOUT)` na leitura/accept. Reaper agendado = follow-up.
- **`endCall(callId, reason)`** é método de serviço exportado (sem HTTP) — o Billing chama com `NO_CREDITS`.
- **OCUPADA derivada:** `CallService.activeModelIds(ids)` retorna quais modelos têm chamada ACTIVE; a descoberta usa isso.
- **`npx tsc --noEmit` limpo;** `import type` em interfaces injetadas.
- **Migração não-interativa** (migrate diff + deploy, UTF-8 sem BOM); teste via `db:test:push`.
- **Não alterar** tabelas de ledger/identidade/kyc; o Marketplace muda só no card (status) e na importação do CallsModule.

## 4. Modelo de dados (Prisma)

```prisma
model Call {
  id                    String    @id @default(uuid())
  clientUserId          String
  modelUserId           String
  status                String    // REQUESTED | ACTIVE | ENDED
  endReason             String?   // REJECTED | TIMEOUT | HANGUP_CLIENT | HANGUP_MODEL | PANIC | NO_CREDITS
  pricePerMinuteSnapshot Decimal  @db.Decimal(14, 2)
  roomName              String?   // setado no ACTIVE (call:<id>)
  requestedAt           DateTime  @default(now())
  startedAt             DateTime?
  endedAt               DateTime?

  @@index([modelUserId, status])
  @@index([clientUserId, status])
  @@map("calls")
}
```

Sem FK (padrão string-loose do projeto). As invariantes "uma aberta por cliente/modelo"
são impostas por advisory lock + checagem, não por índice único parcial (ver §2).

## 5. Componentes

```
calls/
  media-server.port.ts        MEDIA_SERVER token + MediaServerProvider
                              issueToken(roomName, identity): Promise<{ token: string; url: string }>
  fake-media-server.adapter.ts    fake p/ teste (token/url determinístico, sem rede)
  livekit-media-server.adapter.ts stub real: issueToken lança Error('media server not configured')
  call.service.ts             initiate, accept, reject, hangup, panic, endCall, getForParticipant, activeModelIds
  call.controller.ts          POST /calls, /calls/:id/accept|reject|hangup|panic; GET /calls/:id
  calls.module.ts             imports Prisma, Ledger, Auth, Users (Redis é @Global); provê+exporta CallService
```

Reusa: `LedgerService.getBalance`, `RedisService.getStatus` (ONLINE), `prisma.modelProfile` (preço), guards.

## 6. Fluxos

### 6.1 Iniciar (`POST /calls { modelId }`, CLIENT)
`$transaction`, com advisory locks de `client:<clientId>` e `model:<modelId>` (adquiridos em
ordem determinística pra evitar deadlock):
1. Cliente já tem chamada aberta (status != ENDED)? → 409.
2. Modelo: existe, `role=MODEL`, `status=ACTIVE`, tem `ModelProfile`? senão 404. Já tem chamada aberta? → 409 (ocupada). Presença `ONLINE`? senão 409 (offline/indisponível).
3. `balance = getBalance('client:'+clientId)`; `price = profile.pricePerMinute`; `balance < price` → 402.
4. Cria `Call` REQUESTED com `pricePerMinuteSnapshot = price`.
5. Retorna a call.

### 6.2 Aceitar (`POST /calls/:id/accept`, MODEL = callee)
`$transaction` sob advisory lock de `client:<clientId>` da call:
1. Call existe e `modelUserId == req.user.id`? senão 404/403.
2. Lazy timeout: REQUESTED com idade > 30s → `ENDED(TIMEOUT)` e responde 409 (expirada).
3. Status deve ser REQUESTED (senão 409).
4. Re-check: cliente não tem OUTRA call ACTIVE; `getBalance >= pricePerMinuteSnapshot`. Falhou → `ENDED(NO_CREDITS)` e responde 402.
5. Transiciona ACTIVE: `startedAt = now`, `roomName = call:<id>`.
6. Emite token da modelo via `MediaServerProvider.issueToken(roomName, 'model:'+modelId)`.
7. Retorna `{ call, media: { token, url } }`.

### 6.3 Rejeitar (`POST /calls/:id/reject`, MODEL)
Call REQUESTED da modelo → `ENDED(REJECTED)`. Senão 409.

### 6.4 Encerrar (`POST /calls/:id/hangup`, participante)
- ACTIVE → `ENDED(HANGUP_CLIENT|HANGUP_MODEL)` conforme quem chamou; `endedAt = now`.
- REQUESTED + quem chama é o cliente → cancela: `ENDED(HANGUP_CLIENT)`.
- Já ENDED → 200 idempotente (no-op).

### 6.5 Pânico (`POST /calls/:id/panic`, MODEL participante)
ACTIVE → `ENDED(PANIC)`, `endedAt = now`. (O bloqueio por CPF é Trust & Safety/abuso — fora de escopo; aqui só encerra.)

### 6.6 Consultar / entrar (`GET /calls/:id`, participante)
Aplica lazy timeout. Retorna a call; se ACTIVE e o solicitante é participante, inclui
`media: { token, url }` emitido sob demanda para a identidade dele (`client:<id>` ou `model:<id>`).

### 6.7 `endCall(callId, reason)` (serviço, sem HTTP)
ACTIVE → `ENDED(reason)`, `endedAt = now`. O Billing chama com `'NO_CREDITS'`. Idempotente.

### 6.8 OCUPADA na descoberta (integração Marketplace)
`CallService.activeModelIds(modelIds: string[]): Promise<Set<string>>` — quais têm call ACTIVE.
A `DiscoveryService` passa a montar o card com `status: 'ONLINE'|'OCUPADA'|'OFFLINE'`
(OCUPADA se em `activeModelIds`, senão presença ONLINE/OFFLINE), substituindo `isOnline`.
Ordenação da vitrine: **ONLINE → OCUPADA → OFFLINE → (favoritas) → createdAt desc**.

## 7. Tratamento de erros

- 401: sem token. 403: papel errado (CLIENT em accept/reject/panic; não-participante).
- 404: call inexistente; modelo não chamável.
- 409: modelo ocupada/offline; cliente já em chamada; estado inválido (accept em não-REQUESTED, ring expirada).
- 402: saldo insuficiente (início ou re-check do accept).
- Boot: o adaptador real de mídia exige config; o stub lança só ao emitir token (app boota sem creds).

## 8. Testes (integração, contra Postgres + Redis reais, MediaServer fake)

1. Ciclo feliz: client `POST /calls` → REQUESTED; model accept → ACTIVE + token; client `GET` → token; hangup → ENDED(HANGUP_*).
2. Gate: modelo OFFLINE → 409; modelo não-ACTIVE/sem-perfil → 404; saldo < preço → 402; papel CLIENT no accept → 403.
3. Modelo ocupada: segundo cliente liga p/ modelo em call ACTIVE → 409.
4. Cliente já em chamada: segundo `POST /calls` do mesmo cliente → 409.
5. **Concorrência (a invariante):** cliente com saldo p/ exatamente 1 min tenta abrir 2 chamadas concorrentes (`Promise.allSettled`) → exatamente 1 REQUESTED criada, a outra 409. (Teste falha sem o advisory lock.)
6. Reject → ENDED(REJECTED).
7. Timeout lazy: REQUESTED com `requestedAt` no passado (>30s) → `GET`/accept retorna/efetiva ENDED(TIMEOUT).
8. Pânico: ACTIVE → ENDED(PANIC).
9. `endCall(NO_CREDITS)`: ACTIVE → ENDED(NO_CREDITS); idempotente em call já ENDED.
10. Snapshot: `pricePerMinuteSnapshot` = preço no REQUESTED, mesmo que o perfil mude depois.
11. Token de mídia: accept e GET emitem `{token,url}` (fake) para a identidade certa.
12. OCUPADA: modelo em call ACTIVE aparece com `status: 'OCUPADA'` na descoberta; ordenação ONLINE→OCUPADA→OFFLINE.
13. `activeModelIds` retorna só modelos com call ACTIVE.

## 9. Sequência de implementação (sugerida)
Schema `Call` → media port (fake + stub) → CallService.initiate (locks + gate) → accept (re-check) → reject/hangup/panic/endCall + GET → controller → integração OCUPADA na descoberta → suíte completa.
