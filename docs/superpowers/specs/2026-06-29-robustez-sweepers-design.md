# Spec — Robustez: sweepers de recarga expirada e saque travado

**Data:** 2026-06-29
**Status:** Design (execução autorizada — lote "B", sem credencial).
**Tipo:** Robustez operacional — recuperação de estados pendurados.
**Depende de:** Wallet/Recharge, Payout/Processor, Scheduler (todos prontos).

---

## 1. Objetivo e escopo
Dois estados podem ficar pendurados hoje:
1. **Recarga PENDING expirada** — o cliente gerou o PIX, não pagou, e o registro fica PENDING pra
   sempre (poluindo o histórico e a cobrança).
2. **Saque travado em PROCESSING** — um worker reivindica `PENDING→PROCESSING` e morre antes de
   concluir; o saque nunca chega a PAID/FAILED (há um `TODO` explícito no `payout.processor.ts`).

Esta fatia entrega os dois varredores + o agendamento, reaproveitando a infra de `@Interval`
existente (gated por `SCHEDULERS_ENABLED`).

**No escopo:**
- Recarga: `WalletService.expireStaleRecharges()` marca PENDING com `expiresAt < agora` como
  `EXPIRED` (idempotente). Tick no scheduler.
- Saque: coluna `Payout.processingAt` (carimbada ao reivindicar); `PayoutProcessor.recoverStuck()`
  re-reivindica PROCESSING parados além de um limiar e re-tenta o envio (idempotente por `payout.id`).
  Refatorar o bloco enviar/estornar num `settle(payout)` privado (DRY) usado pelos dois caminhos.
- Scheduler: o tick de payout passa a chamar `recoverStuck` após `processPending`; novo tick varre
  recargas expiradas.

**Fora de escopo:** cancelar a cobrança no PSP ao expirar; alertas/notificação; painel de métricas;
limite configurável por UI (usa env).

## 2. Constraints globais
- **Idempotência:** `expireStaleRecharges` só toca `status='PENDING' AND expiresAt < now`.
  `recoverStuck` só toca PROCESSING parados (`processingAt < now - STUCK` ou `processingAt IS NULL`),
  e re-reivindica via `updateMany` guardado (evita corrida com outro worker).
- **Reenvio seguro:** `psp.sendPix` é idempotente por `payout.id` (chave de idempotência), então
  re-tentar um PROCESSING parado não dupla-paga. O caminho de erro estorna no ledger e marca FAILED
  (mesma lógica atual).
- **Migração aditiva:** `processingAt TIMESTAMP(3) NULL` — coluna nova, nullable, retrocompatível.
- **Gate:** ticks só rodam com `SCHEDULERS_ENABLED='true'` (igual aos existentes).
- `import type`; backend `npx tsc --noEmit` limpo; testes via Postgres de teste (`jest-integration`).

## 3. Componentes
```
prisma/schema.prisma                       + Payout.processingAt                       [mod]
prisma/migrations/<ts>_payout_processing_at/migration.sql                              [novo]
src/payout/payout.processor.ts             + settle() (DRY) + recoverStuck() + carimbo  [mod]
src/wallet/wallet.service.ts               + expireStaleRecharges()                     [mod]
src/scheduler/payout.scheduler.ts          tick também chama recoverStuck               [mod]
src/scheduler/recharge.sweeper.ts          @Interval → expireStaleRecharges             [novo]
src/scheduler/scheduler.module.ts          + RechargeSweeper + WalletModule             [mod]
test/payout.recover-stuck.spec.ts                                                       [novo]
test/wallet.expire-recharges.spec.ts                                                    [novo]
test/recharge.sweeper.spec.ts (ou estender payout.scheduler.spec)                       [novo]
```

## 4. Detalhes
### 4.1 Payout — `processingAt` + `recoverStuck` + `settle`
- Schema: `processingAt DateTime?` em `Payout`. Migração: `ALTER TABLE "payouts" ADD COLUMN
  "processingAt" TIMESTAMP(3);`.
- Ao reivindicar PENDING→PROCESSING, gravar também `processingAt: new Date()`.
- Extrair `private async settle(payout)`: tenta `psp.sendPix` → `PAID`+`processedAt`; no catch,
  transação de estorno no ledger (`SAQUE_ESTORNO`/`SAQUE_ESTORNO_OFFSET`) + `FAILED`+`processedAt`.
  `processPending` e `recoverStuck` chamam `settle`.
- `recoverStuck(stuckMs = STUCK_MS)`: busca PROCESSING com `processingAt < now-stuckMs` **ou**
  `processingAt = null` (legados); pra cada, `updateMany({where:{id,status:'PROCESSING'}, data:{processingAt:now}})`
  pra re-reivindicar; se `count===1`, `settle(payout)`. `STUCK_MS` default 120_000 (env `PAYOUT_STUCK_MS`).

### 4.2 Recarga — `expireStaleRecharges`
- `expireStaleRecharges(): Promise<number>` → `prisma.recharge.updateMany({ where: { status:
  'PENDING', expiresAt: { lt: new Date() } }, data: { status: 'EXPIRED' } })`; retorna `count`.

### 4.3 Scheduler
- `payout.scheduler.ts`: após `processPending()`, chamar `recoverStuck()` no mesmo tick (try/catch
  com log, sem derrubar o tick).
- `recharge.sweeper.ts`: `@Interval(RECHARGE_SWEEP_INTERVAL_MS=60_000)` → se `SCHEDULERS_ENABLED`,
  `walletService.expireStaleRecharges()` com try/catch+log.
- `scheduler.module.ts`: importar `WalletModule`; registrar `RechargeSweeper`.

## 5. Erros
- Falha de PSP no `settle` durante recovery → estorno + FAILED (idêntico ao fluxo normal).
- Ticks engolem exceções e logam (não derrubam o agendador).

## 6. Testes (integração, Postgres de teste)
- **`recoverStuck`:** semeia PROCESSING com `processingAt` antigo → `recoverStuck()` → PAID (sendPix
  chamado). Um PROCESSING com `processingAt` recente **não** é tocado. PROCESSING com `processingAt
  null` é recuperado. Falha de PSP → FAILED + estorno no ledger.
- **claim carimba `processingAt`:** após `processPending`, payouts reivindicados têm `processingAt`.
- **`expireStaleRecharges`:** PENDING vencida → EXPIRED; PENDING não vencida → intacta; PAID →
  intacta; retorna a contagem certa.
- **scheduler:** com `SCHEDULERS_ENABLED='true'`, o tick de recarga expira vencidas; sem a flag,
  nada acontece.
- `npx tsc --noEmit` limpo.

## 7. Verificação manual
Com `SCHEDULERS_ENABLED=true`: uma recarga vencida vira EXPIRED no próximo tick; um saque deixado em
PROCESSING (simulado) é reprocessado e some do limbo.

## 8. Sequência
Schema+migração+`recoverStuck`/`settle`+carimbo (T1) → `expireStaleRecharges` (T2) → wiring no
scheduler (T3) → verificação.
