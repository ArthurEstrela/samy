# Spec — Experiência de Chamada (voz, LiveKit)

**Data:** 2026-06-29
**Status:** Design (execução autorizada — "construa agora, eu plugo depois").
**Tipo:** Fatia final de produto — a ligação de voz cliente↔modelo.
**Depende de:** Motor de Chamadas (backend pronto: initiate/accept/hangup/get + token LiveKit), LiveKit (`livekit-client`), Frontend.

---

## 1. Objetivo e escopo

Fechar o produto: o cliente liga pra uma modelo online, ela atende, e os dois conversam por voz
(LiveKit). O backend já faz tudo (o `accept`/`GET /calls/:id` já devolvem o token LiveKit); falta a
**UI dos dois lados**, a **integração do cliente LiveKit** (áudio) e um endpoint de **sinalização**
(a modelo descobrir a chamada chegando, via polling).

**No escopo:**
- Backend: `GET /calls/incoming` (MODEL) — a chamada REQUESTED (não expirada) destinada à modelo, ou null.
- Frontend: `livekit-client`; `CallScreen` (`/call/:id`) compartilhada; iniciar (cliente, no perfil);
  `IncomingCallWatcher` (modelo, no painel); áudio (publica mic + toca remoto), cronômetro, mutar, desligar, pânico.

**Constraint de credencial (decisão "plugo depois"):** o código é construído e testado agora com
**API e LiveKit mockados**; o áudio real só liga quando o backend tiver `LIVEKIT_API_KEY/SECRET/URL`
(o adaptador `LivekitMediaServer` real já existe). Sem chaves, `accept`/`GET` lançam "not configured"
— então a chamada ao vivo não roda; os testes não dependem disso.

**Fora de escopo:** websockets/push real-time (usamos polling 2–3s); vídeo; gravação; chat de texto;
fila de espera; reconexão automática avançada.

## 2. Constraints globais

- `GET /calls/incoming` (`@Roles('MODEL')`) → `{ call: Call | null }` — `CallService.incomingFor(modelId)`:
  `findFirst` REQUESTED de `modelUserId=<id>` com `requestedAt` dentro do RING_TIMEOUT (não expirada),
  mais recente. Não altera o motor de chamadas existente.
- O front usa os endpoints existentes inalterados: `POST /calls` (CLIENT, `{modelId}`), `POST /calls/:id/accept`
  (MODEL), `POST /calls/:id/reject` (MODEL), `POST /calls/:id/hangup` (participante), `POST /calls/:id/panic`
  (MODEL), `GET /calls/:id` → `{ call, media? }` (media `{token,url}` quando ACTIVE).
- **Áudio atrás de uma interface mockável** (`lib/call-media.ts`): os testes mockam esse módulo;
  nenhum teste fala com LiveKit de verdade.
- Polling: `GET /calls/:id` a cada ~2s enquanto `status !== 'ENDED'`; `GET /calls/incoming` a cada ~3s
  enquanto a modelo está no painel.
- Anonimato: a UI de chamada mostra `stageName` (cliente vê) / "Cliente" (modelo vê) — nunca nome real.
- `import type` em tipos; backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo.

## 3. Componentes

```
src/calls/call.service.ts          + incomingFor(modelId)                    [mod]
src/calls/call.controller.ts       + GET /calls/incoming (@Roles MODEL)      [mod]
test/call.incoming.e2e-spec.ts                                              [novo]
web/package.json                   + livekit-client                          [mod]
web/src/types/api.ts               + Call, MediaToken, CallView              [mod]
web/src/lib/call-media.ts          connectCallRoom (wrapper livekit-client)  [novo]
web/src/calls/useCall.ts / useCallActions.ts / useIncomingCall.ts            [novo]
web/src/calls/CallScreen.tsx       tela de chamada (ambos os lados)          [novo]
web/src/calls/IncomingCallWatcher.tsx  overlay de chamada recebida (modelo)  [novo]
web/src/calls/call.test.tsx                                                 [novo]
web/src/App.tsx                    + rota /call/:id                          [mod]
web/src/profile/ModelProfilePage.tsx  habilita "Iniciar chamada" (ONLINE)    [mod]
web/src/model/ModelDashboard.tsx   + <IncomingCallWatcher/>                  [mod]
```

## 4. Detalhes

### 4.1 Backend — incoming
- `CallService.incomingFor(modelId: string): Promise<Call | null>` → `prisma.call.findFirst({ where:{ modelUserId: modelId, status:'REQUESTED', requestedAt:{ gt: new Date(Date.now() - RING_TIMEOUT_SECONDS*1000) } }, orderBy:{ requestedAt:'desc' } })`.
- `CallController`: `@Get('incoming') @Roles('MODEL')` → `{ call: await this.calls.incomingFor(req.user.id) }`.

### 4.2 Frontend — tipos
`MediaToken { token: string; url: string }`; `Call { id; clientUserId; modelUserId; status; endReason: string|null; pricePerMinuteSnapshot: string; roomName: string|null; startedAt: string|null }`; `CallView { call: Call; media?: MediaToken }`.

### 4.3 Frontend — `lib/call-media.ts` (wrapper LiveKit, mockável)
- `connectCallRoom(url: string, token: string): Promise<CallRoomHandle>` — cria um `Room` do
  `livekit-client`, conecta, habilita o microfone, e anexa/toca as faixas de áudio remotas.
- `CallRoomHandle { setMuted(muted: boolean): void; disconnect(): Promise<void> }`.
- (Os testes mockam este módulo inteiro; ele não é unit-testado contra o SDK.)

### 4.4 Frontend — hooks
- `useCall(id)` → `useQuery(['call', id], GET /calls/:id)`, `refetchInterval` 2000 enquanto status !== 'ENDED'.
- `useCallActions()` → mutations `initiate({modelId})` (POST /calls), `accept(id)`, `reject(id)`, `hangup(id)`, `panic(id)`.
- `useIncomingCall(enabled)` → `useQuery(['incoming'], GET /calls/incoming, { refetchInterval: 3000, enabled })`.

### 4.5 Frontend — `CallScreen` (`/call/:id`, ambos os lados)
- Lê `useCall(id)`. Estados:
  - `REQUESTED` → "Chamando…" (cliente) / (se a modelo chegar aqui antes de ACTIVE, mostra conectando) + botão **Cancelar/Desligar** (hangup).
  - `ACTIVE` → conecta via `connectCallRoom(media.url, media.token)` (uma vez); UI em-chamada: **cronômetro** (a partir de `startedAt`), **mutar** (`handle.setMuted`), **desligar** (hangup → `handle.disconnect`), e **pânico** (só modelo, `panic`).
  - `ENDED` → "Chamada encerrada" + motivo (`endReason`) + voltar. Garante `handle.disconnect()`.
- Falha ao conectar o áudio → aviso "não foi possível conectar o áudio" (não derruba a tela).

### 4.6 Frontend — iniciar (cliente) e receber (modelo)
- `ModelProfilePage`: o botão "Iniciar chamada" deixa de ser fixo-desabilitado — fica **habilitado quando
  `status === 'ONLINE'`**; onClick → `initiate({modelId})` → navega `/call/<novaCallId>`. Erros: 402 (saldo) /
  409 (ocupada/offline) → mensagem.
- `IncomingCallWatcher` (montado no `/painel`): `useIncomingCall(enabled=true)`; quando vier uma `call`,
  mostra um **overlay tocando** com stage "Chamada recebida" + **Aceitar** (accept → navega `/call/:id`) /
  **Recusar** (reject → some).

## 5. Tratamento de erros
- `initiate` 402/409 → mensagem clara no perfil; não navega.
- `accept` que retorna erro (timeout/sem crédito) → a CallScreen do cliente verá ENDED no próximo poll.
- LiveKit não configurado (sem chaves) → `accept`/`GET` 500 no backend; o front mostra erro de conexão
  (esperado até plugar as chaves).
- `GET` 401 → refresh existente.

## 6. Testes (boundary de API + `call-media` mockados)
- **Backend (`test/call.incoming.e2e-spec.ts`):** incoming devolve a chamada REQUESTED da modelo;
  null quando não há; expirada não conta; CLIENT → 403.
- **Frontend (`web/src/calls/call.test.tsx`):**
  - CallScreen: REQUESTED mostra "Chamando" + Desligar; quando `useCall` vira ACTIVE+media, chama
    `connectCallRoom(url, token)` (mock) e mostra o cronômetro/Desligar; Desligar chama `POST hangup` e
    `handle.disconnect`; ENDED mostra o motivo.
  - IncomingCallWatcher: com `GET /calls/incoming` devolvendo uma call, mostra Aceitar; Aceitar chama
    `POST /calls/:id/accept`.
  - ModelProfilePage: botão habilitado com status ONLINE → `POST /calls`.
- Suíte backend + `npm run build` do front verdes.

## 7. Verificação manual (com chaves do LiveKit)
Plugado `LIVEKIT_*` no backend: cliente (aba 1) abre o perfil de uma modelo ONLINE → "Iniciar chamada";
modelo (aba 2, `/painel` online) vê o overlay → Aceitar → os dois entram na `CallScreen`, **áudio conecta**,
cronômetro corre (taxímetro cobra), mutar funciona, Desligar encerra.

## 8. Sequência de implementação
Backend incoming (+e2e) → front: `call-media` wrapper + tipos → CallScreen + hooks + rota + testes →
iniciar (perfil) → IncomingCallWatcher (painel) → verificação.
