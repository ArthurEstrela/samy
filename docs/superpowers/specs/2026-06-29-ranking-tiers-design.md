# Spec — Ranking & Tiers (gamificação das modelos)

**Data:** 2026-06-29
**Status:** Design (execução autorizada — lote "B", sem credencial).
**Tipo:** Feature de engajamento/receita — tier por desempenho que reduz a comissão da plataforma.
**Depende de:** Ledger, Billing (split + takeRate), Marketplace (perfil/descoberta), Frontend, seed-demo.

---

## 1. Objetivo e escopo

Dar às modelos um **ranking por desempenho** (tiers) que (a) gamifica a plataforma e (b) **reduz a
comissão** conforme a modelo sobe de tier — quanto mais ela fatura, mais ela retém. O score é o
**ganho bruto vitalício** já registrado no ledger (entradas `GANHO_*` em `model:${id}`), então não
exige nova coluna de dados nem job: é derivado.

**No escopo:**
- Backend: lógica pura de tier (`ranking.ts`: thresholds + `tierForEarnings`), `RankingService`
  (agrega ganho bruto, resolve tier de uma modelo, leaderboard top-N), `RankingController`
  (`GET /ranking/me`, `GET /ranking/top`). Integração no **Billing**: a `takeRate` efetiva passa a
  usar a taxa do tier como *fallback* (override manual do admin ainda vence).
- Frontend: `useMyRanking` + badge de tier com progresso no painel da modelo; página pública
  `/ranking` (leaderboard) com badges e link pro perfil.
- Seed: nada novo obrigatório (tiers emergem dos ganhos do seed; demo continua em BRONZE).

**Fora de escopo (follow-up):** histórico/animação de subida de tier; tier por janela móvel
(usamos vitalício); badges no card de descoberta; recálculo retroativo de splits passados
(imutáveis — só splits futuros usam o tier atual).

## 2. Constraints globais

- **Score = ganho bruto vitalício:** soma de `LedgerEntry.amount` onde `account = model:${id}` e
  `amount > 0` (entradas `GANHO_MIN` / `GANHO_PRESENTE`). Saques (negativos) **não** reduzem o score.
- **Tiers e taxas (default; configurável por env, valores em créditos):**
  | Tier | Ganho bruto ≥ | takeRate (comissão) |
  |------|---------------|----------------------|
  | BRONZE | 0 | 0.30 |
  | PRATA | 500 | 0.25 |
  | OURO | 2000 | 0.20 |
  | DIAMANTE | 10000 | 0.15 |
  Env opcionais `RANKING_THRESHOLDS` / `RANKING_RATES` sobrescrevem; ausentes → defaults acima.
- **Resolução da takeRate efetiva (nova ordem):** `override manual (admin) → taxa do tier → global`.
  Implementado mantendo `resolveTakeRate(override, fallback)` e passando `fallback = tierRate`.
  O Billing calcula o ganho bruto da modelo **dentro da mesma transação** do split e usa a taxa do
  tier como fallback. Monotônico: a entrada corrente ainda não conta, então nunca "pula" tier no meio.
- **Privacidade/anonimato:** o leaderboard expõe só `stageName` + tier + posição — **nunca**
  `displayName` nem valores de ganho. `GET /ranking/me` expõe o ganho só pra própria modelo.
- **Imutabilidade do ledger:** splits já postados não mudam; só cobranças futuras usam o tier atual.
- `import type` em tipos; backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo.

## 3. Componentes

```
src/ranking/ranking.ts                 tierForEarnings + thresholds/rates (puro)     [novo]
src/ranking/ranking.service.ts         ganho bruto, resolveMyRanking, top            [novo]
src/ranking/ranking.controller.ts      GET /ranking/me, GET /ranking/top             [novo]
src/ranking/ranking.module.ts                                                        [novo]
src/billing/billing.service.ts         usa tierRate como fallback no resolveTakeRate [mod]
src/app.module.ts                      + RankingModule                               [mod]
web/src/types/api.ts                   + MyRanking, RankingEntry                     [mod]
web/src/ranking/useMyRanking.ts                                                      [novo]
web/src/ranking/useRankingTop.ts                                                     [novo]
web/src/ranking/TierBadge.tsx          badge reutilizável (tier→cor)                 [novo]
web/src/ranking/RankingPage.tsx        leaderboard público (/ranking)                [novo]
web/src/model/ModelPanelPage.tsx (ou painel)  + badge de tier + progresso           [mod]
web/src/App.tsx / router               + rota /ranking + link na nav                 [mod]
```
(Os nomes exatos do painel da modelo no front são confirmados na fase de plano.)

## 4. Detalhes

### 4.1 `ranking.ts` (puro, testável)
- `TIERS` ordenado asc: `[{tier:'BRONZE', min:0, rate:0.30}, ...]`.
- `tierForEarnings(earned: Decimal): { tier, rate: Decimal, nextTier|null, nextThreshold|null,
  remaining|null }` — acha o maior tier cujo `min ≤ earned`; calcula o próximo e quanto falta.
- Leitura de env com parsing defensivo (formato inválido → defaults, sem derrubar o boot).

### 4.2 `RankingService`
- `grossEarned(modelId)`: `prisma.ledgerEntry.aggregate(_sum amount)` com `account=model:${id}` e
  `amount: { gt: 0 }`. (Pode receber `tx` opcional pra reuso no Billing.)
- `myRanking(modelId)`: `tierForEarnings(grossEarned)` + o `earned`.
- `top(limit)`: agrega ganho bruto por `account` (groupBy account, sum amount>0, filtrando
  `account LIKE 'model:%'`), ordena desc, pega top-N, resolve `stageName` via `modelProfile`,
  atribui posição e tier. Limit default 20, máx 100.

### 4.3 Billing
- Em `chargeMinute` e `sendGift`: substituir `this.globalTakeRate` como fallback por
  `tierRate = rankingService.tierRateFor(modelId, tx)` (que internamente usa `grossEarned` + `tierForEarnings`).
  `resolveTakeRate(profile?.takeRate ?? null, tierRate)` — override manual continua tendo prioridade.
- `BillingModule` importa `RankingModule` (sem ciclo: ranking não depende de billing).

### 4.4 Frontend
- `MyRanking { tier, earned, takeRate, nextTier, nextThreshold, remaining }`;
  `RankingEntry { rank, stageName, tier, modelId }`.
- `useMyRanking()` → `GET /ranking/me` (modelo). `useRankingTop()` → `GET /ranking/top`.
- `TierBadge({tier})`: pílula com cor por tier (BRONZE âmbar-escuro, PRATA mist, OURO gold,
  DIAMANTE ember) usando os tokens.
- Painel da modelo: badge do tier + barra "faltam X créditos pra {nextTier}" (ou "tier máximo").
- `RankingPage`: lista top-N com posição, `TierBadge`, `stageName` e link pro perfil. Vazio →
  "Ranking ainda vazio.".

## 5. Tratamento de erros
- `GET /ranking/me` por não-modelo → 403 (guard de role). `GET /ranking/top` aberto a autenticados.
- Ganho zero → BRONZE, progresso para PRATA. Leaderboard sem modelos com ganho → lista vazia.
- Env malformada → defaults (logado um warn), nunca crash no boot.

## 6. Testes (boundary mockado no front; integração no back)
- **Backend unit (`ranking.spec.ts`):** `tierForEarnings` nos limites (0, 499.99, 500, 2000, 10000,
  acima) → tier/rate/next corretos.
- **Backend integração (`ranking.e2e` ou service):** semeia ledger pra uma modelo, `myRanking`
  reflete o tier; `top` ordena desc e anonimiza (sem displayName/valores); billing aplica a taxa do
  tier no split (uma modelo em OURO retém mais que uma em BRONZE no mesmo preço).
- **Frontend (`ranking.test.tsx`):** `RankingPage` lista entradas com tier/posição; painel mostra o
  badge + progresso a partir de `GET /ranking/me` mockado.
- `npm run build` do front verde; `npx tsc --noEmit` do back verde.

## 7. Verificação manual
Stack no ar: uma modelo com bastante ganho aparece em tier mais alto no painel e no `/ranking`, e
novas cobranças dela retêm mais (comissão menor). Modelo nova fica BRONZE com barra de progresso.

## 8. Sequência de implementação
`ranking.ts` (puro + testes) → `RankingService`/controller/module + endpoints → integração no
Billing (fallback por tier) → front hooks + `TierBadge` + painel + `RankingPage` + rota → verificação.
```
```

## 9. Decisão de produto a confirmar (assíncrono)
Thresholds (500/2000/10000 créditos) e taxas (30/25/20/15%) são **defaults conservadores e
reversíveis** (env-configuráveis). Escolhidos pra avançar sem bloquear; ajustáveis quando você
revisar. Score é **vitalício** (não decai) — mais simples e sem job; se quiser "temporada" com
janela móvel, é um follow-up.
