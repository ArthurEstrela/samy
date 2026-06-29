# Spec — Painel da Modelo #2: Ganhos & Saque

**Data:** 2026-06-29
**Status:** Design (execução autorizada — rodar até concluir as 3 fatias).
**Tipo:** Fatia de produto — a modelo vê ganhos e solicita saque PIX.
**Depende de:** Payout (`requestPayout`), Ledger (`getBalance`), KYC (gate de saque), Auth, Frontend (`/painel`).

---

## 1. Objetivo e escopo

A modelo já loga e fica online (fatia #1), mas não vê ganhos nem saca. Esta fatia expõe os
**ganhos** (saldo em `model:<id>`) e o **saque** (`requestPayout`, hoje sem endpoint HTTP) com
histórico. Inclui um atalho dev pra creditar ganhos + aprovar KYC, deixando o fluxo demonstrável.

**No escopo:**
- Backend: `GET /wallet/earnings` (MODEL); `POST /payouts` + `GET /payouts` (MODEL); `PayoutService.listForAccount`; `POST /payouts/dev-grant` (dev-only).
- Frontend: seção "Ganhos" no `/painel` — saldo, formulário de saque (valor + chave PIX), histórico, estados de erro, botão dev.

**Fora de escopo (próxima fatia / futuro):** fluxo real de KYC (fatia #3); cancelar saque;
escolher tipo de chave PIX (campo texto livre por ora); paginação do histórico.

## 2. Constraints globais

- `GET /wallet/earnings` (`@Roles('MODEL')`) → `{ balance: string }` de `getBalance('model:<req.user.id>')`.
- `POST /payouts` (`@Roles('MODEL')`) body `{ amount: string; pixKey: string }` → `requestPayout('model:<id>', new Decimal(amount), pixKey)`. As exceções do serviço sobem: **KYC não aprovado → 403**, abaixo do mínimo/sem saldo → **400**.
- `GET /payouts` (`@Roles('MODEL')`) → lista os saques do próprio modelo (mais recentes primeiro).
- `POST /payouts/dev-grant` só responde com `DEV_LOGIN==='true'` E `NODE_ENV!=='production'` (mesma dupla-trava); credita ganhos no `model:<id>` e marca KYC aprovado pra ele (atalho dev). Senão `404`.
- Não alterar a lógica de `requestPayout` (lock por conta, MIN_PAYOUT, débito soma-zero) — só expor.
- `import type` em interfaces injetadas; backend `npx tsc --noEmit` limpo; front `npm run build` limpo.
- Front testa com boundary de API mockado.

## 3. Componentes

```
src/wallet/wallet-balance.controller.ts   + GET earnings (@Roles MODEL)            [mod]
src/payout/payout.service.ts              + listForAccount + grantDevEarnings       [mod]
src/payout/payout.controller.ts           POST / + GET / + POST /dev-grant          [novo]
src/payout/payout.module.ts               + PayoutController + Auth/Users/Prisma     [mod]
test/payout.api.e2e-spec.ts               e2e (earnings/request/list/dev-grant)     [novo]

web/src/types/api.ts                      + Payout type                             [mod]
web/src/model/useEarnings.ts                                                       [novo]
web/src/model/usePayouts.ts               lista                                     [novo]
web/src/model/useRequestPayout.ts         + dev-grant                              [novo]
web/src/model/EarningsPanel.tsx           saldo + form + histórico + dev            [novo]
web/src/model/ModelDashboard.tsx          + <EarningsPanel/>                        [mod]
web/src/model/earnings.test.tsx                                                    [novo]
```

## 4. Detalhes

### 4.1 Backend
- `WalletBalanceController`: novo método `@Get('earnings') @Roles('MODEL')` → `{ balance: getBalance('model:'+id).toString() }`.
- `PayoutService.listForAccount(account): Promise<Payout[]>` → `prisma.payout.findMany({ where:{account}, orderBy:{createdAt:'desc'} })`.
- `PayoutService.grantDevEarnings(account): Promise<void>` → `ledger.postTransaction('dev-earn:'+account+':'+Date.now(), [{account, entryType:'GANHO_MIN', amount:+300}, {account:'source:external', entryType:'SEED', amount:-300}])` + `prisma.kycStatus.upsert({ where:{account}, update:{approved:true}, create:{account, approved:true} })`.
- `PayoutController` (`@Controller('payouts')`, `@UseGuards(JwtAuthGuard, RolesGuard)`):
  - `@Post() @Roles('MODEL')` body `{amount, pixKey}` → `requestPayout('model:'+req.user.id, new Prisma.Decimal(amount), pixKey)`. (Valida `amount` parseável → 400.)
  - `@Get() @Roles('MODEL')` → `listForAccount('model:'+req.user.id)`.
  - `@Post(':noop/dev-grant')`? → simpler: `@Post('dev-grant') @Roles('MODEL')` com dupla-trava de env → `grantDevEarnings('model:'+req.user.id)` → `{ ok: true }`.
- `PayoutModule`: importa `AuthModule`, `UsersModule`, `PrismaModule` (guards + prisma); adiciona `PayoutController` aos controllers.

### 4.2 Frontend
- Tipo `Payout { id: string; amount: string; status: string; pixKey: string; createdAt: string; processedAt?: string | null }`.
- `useEarnings()` → `GET /wallet/earnings`. `usePayouts()` → `GET /payouts`. `useRequestPayout()` → mutation `POST /payouts {amount,pixKey}` (invalida earnings+payouts). `devGrant()` → `POST /payouts/dev-grant` (invalida earnings+payouts).
- `EarningsPanel` (no `/painel`): card de **ganhos** (mono); **form de saque** (valor + chave PIX) com botão "Solicitar saque"; **histórico** (lista de Payout com badge de status); estados de erro mapeados: 403 → "Saque requer KYC aprovado"; 400 → "Valor abaixo do mínimo ou saldo insuficiente". Botão dev "Creditar ganhos de teste (dev)" (gated `VITE_DEV_LOGIN`).

## 5. Tratamento de erros
- `POST /payouts`: 403 (KYC) / 400 (min/saldo/amount inválido) → mensagens claras no form.
- `GET earnings/payouts` 401 → refresh existente.
- `dev-grant` desligado → 404 (botão só aparece com `VITE_DEV_LOGIN`).

## 6. Testes
- **Backend (`test/payout.api.e2e-spec.ts`):** GET earnings reflete `model:<id>`; com KYC aprovado + saldo, POST /payouts cria PENDING e debita; sem KYC → 403; abaixo do mínimo → 400; GET /payouts lista; dev-grant (DEV_LOGIN=true) credita+aprova (depois o POST passa) e desligado → 404.
- **Frontend (mockado):** EarningsPanel mostra ganhos; solicitar saque chama `POST /payouts`; histórico renderiza; erro 403 mostra "KYC"; botão dev chama dev-grant.
- Suíte backend + `npm run build` do front verdes.

## 7. Verificação manual
`/painel` como modelo → "Creditar ganhos de teste" → ganhos sobem (e KYC aprovado) → solicitar
saque (valor ≥ 200 + chave) → aparece no histórico como PENDING (o processador de saque, se
`SCHEDULERS_ENABLED`, tenta pagar via PSP — que é stub, então vai a FAILED; aceitável no demo).

## 8. Sequência de implementação
Backend earnings + payout controller (request/list/dev-grant) + service helpers (+e2e) → front
hooks + EarningsPanel + wire no ModelDashboard + testes → verificação manual.
