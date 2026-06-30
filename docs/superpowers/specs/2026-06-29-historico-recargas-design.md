# Spec — Histórico de recargas (Carteira)

**Data:** 2026-06-29
**Status:** Design (execução autorizada — lote "B", sem credencial).
**Tipo:** Feature de transparência — cliente vê o histórico das próprias recargas PIX.
**Depende de:** Wallet/Recharge (backend pronto), Frontend.

---

## 1. Objetivo e escopo
O cliente cria recargas (PIX) mas não tem como ver as anteriores (pagas, pendentes, expiradas).
Esta fatia entrega: **endpoint de listagem** das recargas do próprio cliente + **lista no painel da
Carteira**.

**No escopo:**
- Backend: `GET /wallet/recharge/history` (`@Roles('CLIENT')`) → recargas do `req.user.id`, mais
  recentes primeiro, limite fixo (50). Declarado **antes** de `@Get(':id')` no mesmo controller.
- Frontend: `useRecharges` + `RechargeHistory` na `WalletPage` (lista com valor, status, data).

**Fora de escopo:** paginação/scroll infinito; filtro por status; histórico de consumo/gastos;
exportação. (Follow-up se necessário.)

## 2. Constraints globais
- A rota de lista é **estática** (`/wallet/recharge/history`) e precisa ser registrada **antes** da
  rota param `@Get(':id')` pra não ser capturada como `id` (mesma pegadinha de `/calls/incoming`).
- Só as recargas do próprio cliente (`where userId = req.user.id`); nunca de outro usuário.
- Resposta: `{ id, amount: string, status, createdAt, paidAt }[]` — sem `pspChargeId`/`qrText`
  (dados de cobrança não pertencem ao histórico). `amount` serializado com `.toString()`.
- `import type` em tipos; backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo.
- Front testa com boundary (`fetch`) mockado; e2e back com Postgres de teste.

## 3. Componentes
```
src/wallet/recharge.controller.ts   + @Get('history') ANTES de @Get(':id')   [mod]
web/src/types/api.ts                + RechargeSummary                         [mod]
web/src/wallet/useRecharges.ts                                              [novo]
web/src/wallet/RechargeHistory.tsx                                          [novo]
web/src/wallet/WalletPage.tsx       + <RechargeHistory />                     [mod]
test/wallet.recharge-history.e2e-spec.ts                                    [novo]
web/src/wallet/recharge-history.test.tsx                                    [novo]
```

## 4. Detalhes
### 4.1 Backend
- `@Get('history') @Roles('CLIENT')` → `prisma.recharge.findMany({ where: { userId }, orderBy:
  { createdAt: 'desc' }, take: 50 })`, mapeado pra `{ id, amount: r.amount.toString(), status,
  createdAt: r.createdAt, paidAt: r.paidAt }`. Declarar imediatamente antes do `@Get(':id')`.

### 4.2 Frontend
- `RechargeSummary { id: string; amount: string; status: string; createdAt: string; paidAt: string | null }`.
- `useRecharges()` → `useQuery(['recharges'], GET /wallet/recharge/history)`.
- `RechargeHistory`: card "Recargas" com a lista (valor `⌗ amount`, selo de status, data curta).
  Status mapeado pra rótulo/cor: `PAID`→"paga" (gold), `PENDING`→"pendente" (mist), `EXPIRED`→
  "expirada" (mist), outro→o próprio status. Vazio → "Nenhuma recarga ainda.".
- `WalletPage`: renderiza `<RechargeHistory />` após `<RechargePanel />`.

## 5. Erros
- `GET /wallet/recharge/history` sem token → 401; role MODEL → 403. Lista vazia → estado vazio.

## 6. Testes
- **Backend e2e:** semeia 2 recargas pro cliente A + 1 pro cliente B; `history` de A retorna só as 2
  de A, em ordem desc; não vaza `qrText`/`pspChargeId`; MODEL → 403.
- **Frontend:** `RechargeHistory` lista itens com valor/status; estado vazio.
- `npm run build` verde; `npx tsc --noEmit` verde.

## 7. Verificação manual
Cliente recarrega (mesmo via dev-confirm), abre a Carteira → seção Recargas mostra a recarga com
status e data; uma recarga paga aparece como "paga".

## 8. Sequência
Endpoint de histórico (antes do `:id`) + e2e → front hook + lista + wire → verificação.
