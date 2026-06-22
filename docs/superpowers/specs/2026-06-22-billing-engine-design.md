# Spec — Subsistema Billing Engine (Taxímetro + Gifts)

**Data:** 2026-06-22
**Status:** Design aprovado (aguardando revisão final do usuário)
**Subsistema:** 6 de 6 do ecossistema Samy (blueprint §4.3 + §9 Gifts). O último.
**Depende de:** Carteira & Ledger (`postTransaction` split soma-zero idempotente, `getBalance`), Motor de Chamadas (lê `Call.pricePerMinuteSnapshot`/status, encerra com `NO_CREDITS`), Marketplace (`ModelProfile`), Identidade (papéis/guards).

---

## 1. Objetivo e escopo

Onde o tempo e o desejo viram dinheiro: o **taxímetro** que tarifa cada minuto de uma
chamada ATIVA, e os **gifts** (presentes) que o cliente manda — ambos usando a mesma
mecânica de split (cliente paga, modelo recebe a parte dela, plataforma fica com a comissão).

**No escopo:**
- **Taxímetro — motor `chargeMinute(callId, minuteNumber)`**: cobra um minuto de uma chamada
  ATIVA (split soma-zero idempotente); se o saldo não cobre, encerra a chamada (NO_CREDITS).
- **Gifts**: catálogo (`GiftType`) + `sendGift` (split soma-zero) + registro `Gift`.
- **Take rate** global (env) com override por modelo (`ModelProfile.takeRate`).
- **Split rounding-safe**: comissão arredondada, parte da modelo = preço − comissão (soma zero exato).
- **Serialização do saldo do cliente**: toda operação que debita o cliente (minuto, gift)
  usa a MESMA chave de advisory lock do Motor de Chamadas (`call-client:<clientId>`).

**Fora de escopo (follow-up / outros subsistemas):**
- **Agendador (cron) do taxímetro** — dispara `chargeMinute` a cada minuto. O motor é
  construído e testável agora; o driver é follow-up (igual ao `processPending` dos saques).
- **Aviso de "saldo baixo"** (gatilho de recarga no meio da chamada).
- **Animações / notificações de gift** ("Fulano te mandou uma rosa") — frontend + notificações.
- **Ranking de presenteadores** / gamificação automática.
- **CRUD do catálogo de gifts** — por seed/admin agora; endpoints de gestão depois.

## 2. Decisões fechadas (brainstorm)

- **Take rate global + override por modelo:** `GLOBAL_TAKE_RATE` (env, ex: `0.40`) +
  `ModelProfile.takeRate Decimal?` (nullable → usa o global). Billing usa `model.takeRate ?? global`.
  É o gancho da gamificação de tiers manual (admin seta o takeRate de uma modelo); o motor
  automático de tiers fica adiado.
- **Preço snapshotado, take rate lido fresco:** o `pricePerMinuteSnapshot` da chamada é fixo
  (modelo não muda no meio); o take rate é política da plataforma/admin e é lido na hora da
  cobrança. Aplica a chamadas E gifts.
- **Pré-pago, "cobra o minuto iniciado":** o minuto é cobrado quando começa. Como o `accept`
  (subsistema Chamadas) não pode depender do Billing (ciclo), a regra é: **o agendador dispara
  `chargeMinute(callId, 1)` em t=0 (quando a chamada vira ACTIVE) e `chargeMinute(callId, n)`
  em t=(n−1)·60s.** O motor aceita qualquer `minuteNumber`, então suporta isso; o agendador
  (follow-up) nasce com essa política documentada — sem minutos grátis.
- **Serialização por cliente:** `chargeMinute` e `sendGift` usam `call-client:<clientId>` (a
  mesma chave de `initiate`/`accept`), então minuto × gift × nova-chamada do mesmo cliente
  serializam — impossível overdraw / saldo negativo.

## 3. Constraints globais (vinculam todas as tasks)

- **Split soma-zero rounding-safe:** `commission = (price × takeRate).toDecimalPlaces(2)`;
  `modelShare = price − commission`. Lançamentos: cliente `−price`, modelo `+modelShare`,
  plataforma `+commission` → soma exatamente 0. Dinheiro sempre `Prisma.Decimal`, nunca float.
- **Idempotência:** cada minuto via groupRef `call:<callId>:min:<n>`; cada gift via `gift:<uuid>`.
  Re-cobrar o mesmo minuto é no-op (pré-checagem por `transactionGroup`) — NÃO re-avalia saldo
  nem encerra a chamada.
- **Advisory lock `call-client:<clientId>`** (idêntico ao Motor de Chamadas) em `chargeMinute` e
  `sendGift`, dentro de `$transaction`. `getBalance` lido com o `tx`.
- **`chargeMinute` só cobra chamada ACTIVE.** Saldo `< price` → encerra inline
  (`tx.call.updateMany({where:{id, status:'ACTIVE'}, data:{ENDED, NO_CREDITS, endedAt}})`) e
  NÃO cobra (pré-pago).
- **`sendGift`** funciona com a modelo offline (presente no perfil); exige modelo existente
  (role MODEL) + `GiftType` ativo + saldo ≥ preço (senão 404/402).
- **Take rate:** `model.takeRate ?? GLOBAL_TAKE_RATE` (Decimal, ex: `0.40`). `GLOBAL_TAKE_RATE`
  por env, fail-fast no boot se ausente.
- **`npx tsc --noEmit` limpo;** `import type` em interfaces injetadas.
- **Migração não-interativa** (migrate diff + deploy, UTF-8 sem BOM); teste via `db:test:push`.
- **Não alterar** ledger/identidade/kyc; Marketplace muda só com a coluna `takeRate`; Calls é
  só lido/encerrado (sem mudança de schema).
- **Conta:** `client:<id>` / `model:<id>` / `platform` (mesmas do ledger).

## 4. Modelo de dados (Prisma)

```prisma
// ModelProfile ganha (alteração aditiva):
//   takeRate  Decimal?  @db.Decimal(5, 4)   // override; null = usa GLOBAL_TAKE_RATE

model GiftType {
  id           String   @id @default(uuid())
  name         String
  priceCredits Decimal  @db.Decimal(14, 2)
  active       Boolean  @default(true)
  createdAt    DateTime @default(now())

  @@map("gift_types")
}

model Gift {
  id            String   @id @default(uuid())
  clientUserId  String
  modelUserId   String
  giftTypeId    String
  priceSnapshot Decimal  @db.Decimal(14, 2)
  createdAt     DateTime @default(now())

  @@index([modelUserId])
  @@map("gifts")
}
```

`takeRate` como `Decimal(5,4)` cobre 0.0000–9.9999 (ex: 0.4000 = 40%). Sem FK (padrão string-loose).

## 5. Componentes

```
billing/
  take-rate.ts            GLOBAL_TAKE_RATE (lê env, fail-fast) + resolveTakeRate(model)
  billing.service.ts      chargeMinute(callId, minuteNumber), sendGift(clientId, modelId, giftTypeId)
  gifts.controller.ts     GET /gifts/catalog, POST /gifts (CLIENT)
  billing.module.ts       imports Prisma, Ledger, Auth, Users (Redis @Global); provê+exporta BillingService
```

Reusa: `LedgerService.postTransaction(groupRef, entries, tx?)` + `getBalance(account, tx?)`;
lê `prisma.call`/`prisma.modelProfile`/`prisma.giftType`; guards. (Não importa CallsModule —
encerra a chamada via `tx.call.updateMany` inline, evitando acoplar ao CallService; lê Call via Prisma.)

> O split (commission/modelShare) é uma função pura compartilhada por `chargeMinute` e `sendGift`.

## 6. Fluxos

### 6.1 `chargeMinute(callId, minuteNumber)` (serviço, sem HTTP)
`$transaction` + `pg_advisory_xact_lock(hashtext('call-client:'+clientId))`:
1. Lê a call. Idempotência: já existe lançamento `transactionGroup = call:<callId>:min:<n>`? → `{ charged:false, alreadyCharged:true }` (sem avaliar saldo, sem encerrar).
2. Call `status != ACTIVE` → `{ charged:false, reason:'not_active' }`.
3. `price = call.pricePerMinuteSnapshot`; `balance = getBalance('client:'+clientId, tx)`.
4. `balance < price` → encerra inline `ENDED(NO_CREDITS)` e `{ charged:false, ended:true }` (não cobra).
5. `takeRate = model.takeRate ?? GLOBAL`; `commission = (price×takeRate).toDP(2)`; `modelShare = price − commission`.
6. `postTransaction('call:'+callId+':min:'+n, [client −price CONSUMO_MIN, model +modelShare GANHO_MIN, platform +commission COMISSAO], tx)`.
7. `{ charged:true }`.

> Para o lock por cliente, a call precisa do `clientUserId` — lido no passo 1 (a call existe; se não, 404/no-op).

### 6.2 `sendGift(clientId, modelId, giftTypeId)` (`POST /gifts`, CLIENT)
`$transaction` + `pg_advisory_xact_lock(hashtext('call-client:'+clientId))`:
1. `GiftType` existe e `active`? senão 404. Modelo existe e `role=MODEL`? senão 404.
2. `price = giftType.priceCredits`; `balance = getBalance('client:'+clientId, tx)`; `balance < price` → 402.
3. `takeRate = model.takeRate ?? GLOBAL`; `commission`/`modelShare` (rounding-safe).
4. Cria `Gift` (priceSnapshot=price) → id `giftId`.
5. `postTransaction('gift:'+giftId, [client −price PRESENTE, model +modelShare GANHO_PRESENTE, platform +commission COMISSAO], tx)`.
6. Retorna o `Gift`.

### 6.3 `GET /gifts/catalog` (autenticado)
Lista os `GiftType` com `active=true`.

## 7. Tratamento de erros
- 401 sem token; 403 papel errado (não-CLIENT no `POST /gifts`).
- 404: `GiftType` inativo/inexistente; modelo inexistente/não-MODEL.
- 402: saldo insuficiente (gift; e o minuto encerra a chamada em vez de 402).
- Boot falha se `GLOBAL_TAKE_RATE` ausente.

## 8. Testes (integração, contra Postgres real)
1. `chargeMinute` cobra o split correto (cliente −5, modelo +3, plataforma +2 com takeRate 0.40) e soma zero.
2. Idempotência: `chargeMinute(callId, 1)` duas vezes → segundo é no-op (`alreadyCharged`), saldo debitado uma vez só.
3. Saldo insuficiente: `chargeMinute` com saldo < preço → chamada vira `ENDED(NO_CREDITS)` e NÃO cobra.
4. Chamada não-ACTIVE (REQUESTED/ENDED): `chargeMinute` → no-op, nada cobrado.
5. Rounding-safe: preço `5.01`, takeRate `0.40` → comissão `2.00`, modelo `3.01`, soma zero exata.
6. Override de takeRate: modelo com `takeRate=0.30` → comissão = 30% (não o global).
7. **Serialização:** cliente com saldo p/ 1 operação dispara `chargeMinute` + `sendGift` concorrentes → só um debita; saldo nunca negativo.
8. `sendGift` posta o split, grava `Gift`, debita o cliente; funciona com modelo OFFLINE.
9. `sendGift` saldo insuficiente → 402; gift/modelo inexistente → 404; não-CLIENT → 403.
10. `GET /gifts/catalog` lista só os ativos.

## 9. Sequência de implementação (sugerida)
Schema (ModelProfile.takeRate + GiftType + Gift) → take-rate.ts (env + resolve + split puro) →
BillingService.chargeMinute (lock + idempotência + cobra/encerra) → BillingService.sendGift →
gifts.controller (catalog + POST) → módulo + suíte completa.

## 10. Nota: a chamada completa, ponta a ponta (quando o cron existir)
Com o agendador (follow-up): cliente liga → accept → ACTIVE → agendador cobra `min:1` em t=0 →
... `min:n` em t=(n−1)·60s → se um minuto não couber no saldo, `chargeMinute` encerra a chamada
(`NO_CREDITS`) → o Motor de Chamadas derruba a mídia. Pré-pago puro, sem minuto grátis, saldo
nunca negativo (serialização por cliente). Este subsistema entrega todas as peças menos o relógio.
