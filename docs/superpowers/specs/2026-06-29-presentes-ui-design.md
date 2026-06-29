# Spec — Presentes (Gifts) UI

**Data:** 2026-06-29
**Status:** Design (execução autorizada — lote "B", sem credencial).
**Tipo:** Feature de receita — cliente envia presente pra modelo.
**Depende de:** Billing/Gifts (backend pronto: `GET /gifts/catalog`, `POST /gifts`), Frontend, seed-demo.

---

## 1. Objetivo e escopo

O backend de presentes está completo (catálogo + enviar, com split soma-zero, 404 e 402), mas não
há UI nem tipos de presente semeados. Esta fatia entrega: **catálogo de presentes** + **enviar
presente** a partir do perfil da modelo, e semeia alguns `GiftType` pro demo.

**No escopo:**
- Backend: semear `GiftType` no `seed-demo.ts` (idempotente). A API de gifts já existe inalterada.
- Frontend: `useGiftCatalog`/`useSendGift`; `GiftPicker` no perfil da modelo (grade do catálogo,
  enviar, feedback, erros 402/404, invalida saldo).

**Fora de escopo (follow-up):** enviar presente dentro da chamada (CallScreen); histórico de
presentes recebidos (modelo); animação de presente; criar/editar tipos de presente (admin).

## 2. Constraints globais

- `GET /gifts/catalog` (qualquer autenticado) → `GiftType[]` (ativos, preço asc). `POST /gifts`
  (`@Roles('CLIENT')`) `{modelId, giftTypeId}` — exceções sobem: **402** (saldo insuficiente),
  **404** (presente inativo / não-modelo).
- Não alterar a API de gifts nem a lógica de `sendGift`.
- Enviar com sucesso → invalida `['balance']` (o saldo do cliente cai).
- Erros mapeados: 402 → "Saldo insuficiente — recarregue."; 404 → "Presente indisponível.".
- `import type` em tipos; backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo.
  Front testa com boundary mockado.

## 3. Componentes

```
prisma/seed-demo.ts                + GiftType seed (upsert por id fixo)       [mod]
web/src/types/api.ts               + GiftType                                 [mod]
web/src/gifts/useGiftCatalog.ts                                              [novo]
web/src/gifts/useSendGift.ts                                                 [novo]
web/src/gifts/GiftPicker.tsx                                                 [novo]
web/src/profile/ModelProfilePage.tsx  + <GiftPicker modelId={...}/>          [mod]
web/src/gifts/gifts.test.tsx                                                 [novo]
```

## 4. Detalhes

### 4.1 Backend — seed
- Em `seed-demo.ts`, após os modelos, `upsert` de ~4 GiftTypes com ids fixos (`gift-rosa`, `gift-beijo`,
  `gift-coracao`, `gift-coroa`) — nome + `priceCredits`. Idempotente (re-rodar atualiza). Loga no resumo.

### 4.2 Frontend
- Tipo `GiftType { id: string; name: string; priceCredits: string; active: boolean }`.
- `useGiftCatalog()` → `useQuery(['gift-catalog'], GET /gifts/catalog)`.
- `useSendGift()` → `useMutation(POST /gifts {modelId, giftTypeId})`, `onSuccess` invalida `['balance']`.
- `GiftPicker({ modelId })` (no perfil): card "Presentes" com a grade do catálogo (nome + `⌗ preço`);
  clicar num presente → `sendGift.mutate({modelId, giftTypeId})`; estados: enviando, "Presente
  enviado ✓", erro 402 → "Saldo insuficiente — recarregue." (com link pra `/wallet`), 404 → "Presente
  indisponível.".
- `ModelProfilePage`: renderiza `<GiftPicker modelId={model.userId} />` (após favoritar/chamada).

## 5. Tratamento de erros
- `POST /gifts` 402 → mensagem + link recarregar; 404 → indisponível; outros → genérico.
- `GET /gifts/catalog` 401 → refresh existente; catálogo vazio → "Nenhum presente disponível.".

## 6. Testes (boundary mockado)
- **Frontend (`web/src/gifts/gifts.test.tsx`):** GiftPicker lista o catálogo; clicar num presente chama
  `POST /gifts` com `{modelId, giftTypeId}`; erro 402 mostra "saldo insuficiente"; sucesso mostra
  "enviado".
- `npm run build` do front verde. (Backend: a API de gifts já é testada; o seed é script.)

## 7. Verificação manual
Stack no ar (com gift types semeados): cliente abre o perfil de uma modelo → seção Presentes →
clica num presente → "Presente enviado ✓" e o saldo cai (header). Sem saldo → "Saldo insuficiente".

## 8. Sequência de implementação
Seed de GiftTypes → front hooks + GiftPicker + wire no perfil + testes → verificação.
