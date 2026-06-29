# Spec — Painel da Modelo #3: KYC

**Data:** 2026-06-29
**Status:** Design (execução autorizada — concluir as 3 fatias).
**Tipo:** Fatia de produto — a modelo inicia e acompanha a verificação de identidade (KYC).
**Depende de:** KYC Verification (`/kyc/start`, `/kyc/me`, `applyResult`), Auth, Frontend (`/painel`).

---

## 1. Objetivo e escopo

A modelo precisa de KYC aprovado pra sacar (fatia #2). Esta fatia entrega a **UI de KYC** no painel:
ver o status, iniciar a verificação, e — como o provedor real não está plugado — um **dev-approve**
que aprova direto (mesmo padrão dos outros atalhos dev), fechando o ciclo modelo → online → ganhos →
**KYC** → saque.

**No escopo:**
- Backend: `POST /kyc/dev-approve` (dev-only) — aprova o KYC da modelo (KycVerification APPROVED +
  KycStatus approved + promove user PENDING_VERIFICATION→ACTIVE), via `KycVerificationService.devApprove`.
- Frontend: seção KYC no `/painel` — status, botão "Iniciar verificação" (`POST /kyc/start`), botão
  dev "Aprovar KYC (simular)".

**Reusa inalterado:** `GET /kyc/me` (status), `POST /kyc/start` (já existe; com provedor real cria a
sessão; sem provedor configurado lança erro → a UI trata).

**Fora de escopo:** integração real com provedor de KYC (Sumsub/Veriff etc.); upload de documentos;
re-tentativa após REJECTED além de "iniciar de novo".

## 2. Constraints globais

- `POST /kyc/dev-approve` só responde com `DEV_LOGIN==='true'` E `NODE_ENV!=='production'` (senão `404`).
  Aprova o KYC da própria modelo (conta via `UsersService.accountOf`), numa transação:
  upsert `KycVerification(providerRef='dev:<account>', status:'APPROVED')` + upsert `KycStatus(approved:true)`
  + se o user é `PENDING_VERIFICATION` → `ACTIVE`.
- `/kyc/*` é `@Roles('MODEL')` (já é); a conta deriva de `req.user.id` (nunca do body).
- Não alterar `start`/`applyResult`/`getLatest`.
- Front: botão dev só com `VITE_DEV_LOGIN==='true'`; "Iniciar verificação" trata erro de provedor
  não configurado com mensagem clara.
- `import type` em interfaces; backend `npx tsc --noEmit` limpo; front `npm run build` limpo. Front
  testa com boundary mockado.

## 3. Componentes

```
src/kyc-verification/kyc-verification.service.ts   + devApprove(account, userId)       [mod]
src/kyc-verification/kyc-verification.controller.ts + POST dev-approve (dev-only)        [mod]
test/kyc.dev-approve.e2e-spec.ts                                                        [novo]
web/src/types/api.ts                               + KycStatusView                       [mod]
web/src/model/useKyc.ts                            status + start + dev-approve          [novo]
web/src/model/KycPanel.tsx                                                              [novo]
web/src/model/ModelDashboard.tsx                   + <KycPanel/> (antes de EarningsPanel) [mod]
web/src/model/kyc.test.tsx                                                              [novo]
```

## 4. Detalhes

### 4.1 Backend
- `KycVerificationService.devApprove(account: string, userId: string): Promise<void>` —
  `prisma.$transaction`:
  - `kycVerification.upsert({ where:{providerRef:'dev:'+account}, update:{status:'APPROVED', resolvedAt:now}, create:{account, userId, status:'APPROVED', providerRef:'dev:'+account, clientToken:'dev', sessionExpiresAt: now+1h, resolvedAt: now} })`.
  - `kycStatus.upsert({ where:{account}, update:{approved:true}, create:{account, approved:true} })`.
  - se `user.status === 'PENDING_VERIFICATION'` → `user.update(status:'ACTIVE')`.
- `KycVerificationController`: `@Post('dev-approve')` → dupla-trava de env; `account = users.accountOf({id, role})`; `kyc.devApprove(account, req.user.id)`; retorna `{ ok: true }`.

### 4.2 Frontend
- Tipo `KycStatusView { status: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED'; reason?: string; createdAt?: string; resolvedAt?: string }`.
- `useKyc()`: `status` (`useQuery ['kyc'] GET /kyc/me`), `start` (mutation `POST /kyc/start`, invalida `['kyc']`), `devApprove` (mutation `POST /kyc/dev-approve`, invalida `['kyc']`).
- `KycPanel` (no `/painel`, antes de Ganhos): badge de status (NONE→"não iniciada", PENDING→"em análise",
  APPROVED→"aprovada ✓" dourado, REJECTED→"recusada" + reason); botão **"Iniciar verificação"** →
  `start` (erro de provedor não configurado → "Verificação indisponível no momento."); botão dev
  **"Aprovar KYC (simular)"** (gated `VITE_DEV_LOGIN`) → `devApprove`.

## 5. Tratamento de erros
- `dev-approve` desligado → `404` (botão só com `VITE_DEV_LOGIN`).
- `start` com provedor não configurado → erro do backend → mensagem clara na UI (não quebra).
- `kyc/me` 401 → refresh existente.

## 6. Testes
- **Backend (`test/kyc.dev-approve.e2e-spec.ts`):** `dev-approve` (DEV_LOGIN=true) → `GET /kyc/me`
  vira APPROVED e `kycStatus.approved` true (e o saque da fatia #2 passa); desligado → 404; CLIENT
  em `/kyc/dev-approve` → 403.
- **Frontend (mockado):** KycPanel mostra o status de `GET /kyc/me`; "Iniciar verificação" chama
  `POST /kyc/start`; botão dev (com `VITE_DEV_LOGIN`) chama `POST /kyc/dev-approve`; status APPROVED
  renderiza "aprovada".
- Suíte backend + `npm run build` do front verdes.

## 7. Verificação manual (fecha o ciclo)
`/painel` como modelo → KYC "não iniciada" → "Aprovar KYC (simular)" → status "aprovada ✓" → na
seção Ganhos, "Creditar ganhos de teste" → "Solicitar saque" agora **passa** (sem 403 de KYC).

## 8. Sequência de implementação
Backend devApprove + rota (+e2e) → front useKyc + KycPanel + wire no ModelDashboard + testes →
verificação manual do ciclo completo.
