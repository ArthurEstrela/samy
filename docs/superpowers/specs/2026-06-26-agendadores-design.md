# Spec — Agendadores (Taxímetro + Processador de Saque)

**Data:** 2026-06-26
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Automação de fundo (cron in-process) — fecha o ciclo de dinheiro sem credencial externa.
**Depende de:** Billing Engine (`chargeMinute`), Payout (`PayoutProcessor.processPending`), Calls.

---

## 1. Objetivo e escopo

Hoje o `chargeMinute` e o `processPending` existem e são testados, mas **ninguém os dispara
sozinho** — a cobrança por minuto e o pagamento de saques só rodam se chamados manualmente.
Este trabalho adiciona os dois agendadores in-process que fazem o dinheiro girar
automaticamente, **sem depender de nenhum provedor externo**.

**No escopo:**
- `@nestjs/schedule` + `ScheduleModule.forRoot()` no AppModule.
- **Taxímetro** (`TaximeterService`): a cada 10s, cobra os minutos devidos de toda chamada
  `ACTIVE`, do minuto 1 em diante (prepago).
- **Processador de saque** (`PayoutScheduler`): a cada 60s, chama `processPending()`.
- **Otimização anti-N+1:** campo `billedMinutes Int @default(0)` na `Call` como cursor
  derivado, incrementado dentro da `$transaction` do `chargeMinute`. O taxímetro lê tudo
  numa única query.
- **Liga/desliga** por env `SCHEDULERS_ENABLED` (lógica separada do gate, pra testes
  determinísticos e escala horizontal).

**Fora de escopo (follow-up):**
- **Eleição de líder** pra escala horizontal — idempotência + CAS já tornam seguro rodar em
  N instâncias; só haveria trabalho redundante. Upgrade futuro.
- **Recuperação de saques travados em `PROCESSING`** — já é um TODO existente no
  `PayoutProcessor`.
- Cobrança síncrona do minuto 1 no `accept()` — decisão fechada: o taxímetro cobra tudo
  (mantém Calls desacoplado de Billing; janela grátis ≤10s aceita).
- Intervalos configuráveis por env — constantes nomeadas (YAGNI).

## 2. Decisões fechadas (brainstorm)

- **Taxímetro cobra todos os minutos, inclusive o 1º** (decisão do usuário). O `accept()`
  continua só checando saldo ≥ preço; não debita. Não há acoplamento Calls→Billing.
- **`billedMinutes` é cursor derivado, não fonte da verdade.** O dinheiro continua no Ledger
  (soma-zero, idempotente). O contador só diz "até qual minuto já cobrei". Escrito na mesma
  transação do split, sob o mesmo advisory-lock por cliente → nunca diverge, nunca dupla-conta.
- **Lógica separada do gate.** O handler `@Interval` só delega à lógica se
  `SCHEDULERS_ENABLED`. A lógica (`runDueCharges`, `processPending`) é chamável direto nos
  testes, de forma determinística (sem esperar tempo real, sem ticks de fundo interferindo).
- **Intervalos:** taxímetro 10s (janela grátis ≤10s), saque 60s.

## 3. Constraints globais (vinculam todas as tasks)

- **`billedMinutes` só incrementa no ramo de cobrança bem-sucedida** do `chargeMinute`
  (depois do `postTransaction`, dentro da mesma `$transaction`). Idempotente-skip, NO_CREDITS
  e não-ACTIVE **não** tocam o contador.
- **Após cobrar o minuto n, `billedMinutes == n`** (minutos cobrados em ordem, sem buracos).
- **App boota sem `SCHEDULERS_ENABLED`** — ausente/`false` → handlers viram no-op (não falha).
- **`.env.test` define `SCHEDULERS_ENABLED=false`** — essencial: senão ticks de 10s
  disparariam durante a suíte e dariam testes flaky.
- **Não alterar a semântica financeira** do `chargeMinute` (split soma-zero, idempotência
  por `call:<id>:min:<n>`, lock por cliente, encerra em NO_CREDITS) — só somar o incremento
  do cursor.
- **`import type` em interfaces injetadas.** `npx tsc --noEmit` limpo.
- **Migração** via `prisma migrate diff` + `migrate deploy` (UTF-8 sem BOM), seguindo o
  padrão das migrações existentes em `prisma/migrations`.
- **Taxímetro faz 1 query de leitura por tick** (a `findMany` dos ACTIVE) — nada de
  N leituras no Ledger por chamada.
- A **suíte completa** permanece verde.

## 4. Componentes

```
prisma/schema.prisma                 + Call.billedMinutes Int @default(0)   [modificado]
prisma/migrations/<ts>_billed_minutes/migration.sql                          [novo]
src/billing/billing.service.ts       chargeMinute incrementa billedMinutes  [modificado]
src/scheduler/taximeter.service.ts   @Interval(10s) + runDueCharges()       [novo]
src/scheduler/payout.scheduler.ts    @Interval(60s) + gate                  [novo]
src/scheduler/scheduler.module.ts    importa Billing/Payout/Prisma          [novo]
src/app.module.ts                    ScheduleModule.forRoot() + SchedulerModule [modificado]
.env.example / .env / .env.test      SCHEDULERS_ENABLED                     [modificado]
test/taximeter.spec.ts               lógica do taxímetro (Postgres real)    [novo]
test/payout.scheduler.spec.ts        gate liga/desliga                      [novo]
test/billing.charge-minute.spec.ts   + asserts de billedMinutes             [modificado]
```

## 5. Detalhes

### 5.1 Schema
Adicionar à model `Call`: `billedMinutes Int @default(0)`. Migração gerada por
`prisma migrate diff` (from migrations, to schema) → `migration.sql` em
`prisma/migrations/<timestamp>_billed_minutes/`, aplicada com `migrate deploy`.

### 5.2 `chargeMinute` (modificação cirúrgica)
No único ramo de sucesso, logo após `await this.ledger.postTransaction(group, [...], tx)` e
antes do `return { charged: true }`:
```ts
await tx.call.update({ where: { id: callId }, data: { billedMinutes: { increment: 1 } } });
```
Nada mais muda. (O `increment` é atômico no nível da linha e roda sob o advisory-lock por
cliente, então é seguro mesmo com ticks redundantes.)

### 5.3 `TaximeterService`
- Constante `TAXIMETER_INTERVAL_MS = 10_000`; `enabled = process.env.SCHEDULERS_ENABLED === 'true'`.
- `@Interval(TAXIMETER_INTERVAL_MS) async handleTick()` → `if (this.enabled) await this.runDueCharges();`
- `async runDueCharges(now = new Date()): Promise<void>`:
  ```
  const calls = await prisma.call.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, startedAt: true, billedMinutes: true },
  });
  for (const c of calls) {
    if (!c.startedAt) continue;
    const elapsedMs = now.getTime() - c.startedAt.getTime();
    const dueMinute = Math.floor(elapsedMs / 60_000) + 1;   // min 1 em t=0
    for (let n = c.billedMinutes + 1; n <= dueMinute; n++) {
      const r = await this.billing.chargeMinute(c.id, n);
      if (r.ended) break;          // NO_CREDITS encerrou; sai de ACTIVE
    }
  }
  ```
  Injeta `BillingService` (de `BillingModule`) e `PrismaService`. `now` é parâmetro com
  default pra testar determinístico.

### 5.4 `PayoutScheduler`
- Constante `PAYOUT_INTERVAL_MS = 60_000`; `enabled` igual ao taxímetro.
- `@Interval(PAYOUT_INTERVAL_MS) async handleTick()` → `if (this.enabled) await this.payoutProcessor.processPending();`
- Injeta `PayoutProcessor` (de `PayoutModule`).

### 5.5 `SchedulerModule`
Importa `BillingModule`, `PayoutModule`, `PrismaModule`; provê `TaximeterService` e
`PayoutScheduler`. AppModule importa `ScheduleModule.forRoot()` (uma vez) e `SchedulerModule`.

### 5.6 Env
`SCHEDULERS_ENABLED` — `"true"` liga os ticks. `.env`/`.env.example` → `true`;
`.env.test` → `false`. Documentar no `.env.example` (boota sem; default no-op).

## 6. Tratamento de erros
- Sem `SCHEDULERS_ENABLED=true`, os handlers não fazem nada (não quebram o boot).
- Um erro num `chargeMinute` de uma chamada não deve derrubar o tick inteiro: o loop trata
  cada chamada de forma independente (uma chamada problemática não bloqueia as demais — capturar
  e logar por chamada, seguir). O dinheiro nunca corre risco: `chargeMinute` é transacional.
- Múltiplas instâncias: seguro por idempotência + lock + CAS (só trabalho redundante).

## 7. Testes
- **`test/taximeter.spec.ts`** (Postgres real, chama `runDueCharges(now)` direto):
  - (a) chamada ACTIVE com `startedAt` 130s atrás, `billedMinutes=0`, crédito p/ ≥3 min →
    cobra minutos 1,2,3; saldo cai 3×preço; `billedMinutes==3`; cada split soma-zero.
  - (b) crédito só p/ 2 min → cobra 1,2; no 3 dá NO_CREDITS → chamada `ENDED`/`NO_CREDITS`,
    saldo 0, `billedMinutes==2`.
  - (c) rodar `runDueCharges` 2× é no-op no 2º (idempotente): saldo e `billedMinutes` estáveis.
  - (d) chamada não-ACTIVE é ignorada (nada cobrado).
  - (e) chamada ACTIVE recém-criada (`startedAt` agora) → dueMinute=1 → cobra só o minuto 1.
- **`test/payout.scheduler.spec.ts`** (fake PSP via `.overrideProvider`):
  - habilitado → `handleTick` processa um payout PENDING (vira PAID).
  - desabilitado → `handleTick` não toca o payout (continua PENDING).
- **`test/billing.charge-minute.spec.ts`** (modificado): após cobrar, `billedMinutes` da
  chamada == minuto cobrado; no caminho idempotente e no NO_CREDITS, `billedMinutes` não sobe
  além do correto.
- **Suíte completa** permanece verde; `tsc` limpo.

## 8. Sequência de implementação (sugerida)
Schema `billedMinutes` + migração → `chargeMinute` incrementa (+ asserts no spec de billing) →
`TaximeterService` + teste → `PayoutScheduler` + teste → `SchedulerModule` + wiring no
AppModule + env → suíte completa.
