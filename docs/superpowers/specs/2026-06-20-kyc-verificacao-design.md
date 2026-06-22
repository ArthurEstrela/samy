# Spec — Subsistema KYC (Verificação da Modelo)

**Data:** 2026-06-20
**Status:** Design aprovado (aguardando revisão final do usuário)
**Subsistema:** parte do Trust & Safety (blueprint §4.6) — a metade de KYC, construível agora.
**Depende de:** Carteira & Ledger (lê `kyc_status.approved` no cash-out) e Identidade & Acesso (papéis, guards, `UsersService.setStatus`, `accountOf`). Ambos implementados.

---

## 1. Objetivo e escopo

Construir o **lado de escrita do KYC**: o fluxo que verifica a identidade da modelo
(documento + selfie/liveness) através de um provedor externo e, ao aprovar, libera a
modelo — promovendo-a de `PENDING_VERIFICATION` para `ACTIVE` e marcando
`kyc_status.approved = true` (a flag que o cash-out do ledger já consulta).

Hoje só existe o **lado de leitura** (`KycPort.isApproved` lendo `kyc_status`); este
subsistema é quem **popula** essa tabela.

**No escopo:** KYC da **modelo** — iniciar verificação, receber o resultado do provedor,
aplicar o resultado (liberar/rejeitar), consultar status.

**Fora de escopo (outros subsistemas / follow-up):**
- Proteção contra abuso (botão de pânico, bloqueio por CPF, score de risco por metadados
  de chamada) — depende do subsistema de Chamadas.
- KYC do **cliente** — é o CPF do titular do PIX, capturado no cash-in (Carteira & Ledger).
- Adaptador real do provedor exercitado ponta-a-ponta (precisa de credenciais + front);
  entregamos a porta + adaptador, validados via fake.
- Limite rígido de tentativas / rate-limiting → hardening posterior.
- **Reaper de sessões fantasmas:** cronjob futuro que marca como `EXPIRED` as verificações
  `PENDING` com `sessionExpiresAt` (ou `createdAt`) muito antigas — modelo abandonou no meio
  e o webhook nunca chegou. Não afeta o MVP (o reuso de sessão do §3 já evita criar sessões
  novas em cima de PENDING válidas); o status `EXPIRED` já existe no modelo para o reaper usar.
- **Armazenar qualquer biometria ou imagem de documento** — nunca. A captura acontece no
  provedor; guardamos só resultado + referência.

## 2. Decisão fechada (brainstorm)

- **Provedor externo com captura no provedor.** O backend cria uma *sessão de verificação*
  via porta `KycVerificationProvider`; o provedor devolve um `clientToken` que o app da
  modelo usa no SDK do provedor para capturar doc+selfie **direto no provedor**. Nosso
  backend NUNCA toca nem armazena a imagem/biometria. O provedor processa e chama nosso
  webhook com o resultado. Mesmo padrão porta+fake+webhook do PSP.

## 3. Constraints globais (vinculam todas as tasks)

- **Nenhum dado biométrico/documento é recebido ou armazenado pelo backend.** Só
  `providerRef` (referência opaca da sessão), o `clientToken` da sessão e o resultado.
  (O `clientToken` é um token de sessão de curta duração do provedor — NÃO é biometria nem
  documento; guardá-lo pelo tempo de vida da sessão é aceitável e necessário para o reuso.)
- **Reuso de sessão (custo):** provedores cobram por sessão criada. Antes de criar uma nova
  sessão no `/kyc/start`, reusa-se a verificação `PENDING` mais recente da conta cujo
  `sessionExpiresAt > agora` — devolvendo o `clientToken` já existente, SEM nova chamada
  (paga) ao provedor. Só cria sessão nova se não houver PENDING válida.
- **Webhook autenticado por HMAC-SHA256** do corpo cru, comparação tempo-constante,
  assinatura no header — mesmo molde do `PspSignatureValidator`. Assinatura inválida → 401.
- **Idempotência:** reprocessar o mesmo resultado de webhook é no-op (não aplica duas vezes).
- **Segredo por env, fail-fast no boot:** `KYC_WEBHOOK_SECRET` (boot falha se faltar — mesmo
  padrão do `PSP_WEBHOOK_SECRET`).
- **Aprovação não sobrepõe SUSPENDED:** ao aprovar, promove o usuário só se ele estiver
  `PENDING_VERIFICATION`; se estiver `SUSPENDED`, mantém SUSPENDED (ação do admin vence).
  A flag `kyc_status.approved` é marcada de qualquer forma (o KYC foi aprovado de fato).
- **Aplicação do resultado é atômica:** marcar a verificação + `kyc_status` + status do
  usuário acontecem numa única transação.
- **Conta da modelo:** `model:<userId>` (mesmo `accountOf` do ledger/identidade). A linha de
  `kyc_status` é chaveada por essa string.
- **`npx tsc --noEmit` deve passar:** `import type` para interfaces em posição injetada (TS1272).
- **Migração não-interativa:** `prisma migrate diff` + `prisma migrate deploy` (migrate dev
  trava); banco de teste recebe schema via `db:test:push` que o `test:int` já roda. Migration
  SQL escrita em UTF-8 sem BOM (PowerShell `>` gera UTF-16 → P3018).
- **Não alterar as tabelas do ledger nem do identidade** além de escrever `kyc_status` e
  chamar `UsersService.setStatus`.

## 4. Modelo de dados (Prisma)

```prisma
model KycVerification {
  id               String    @id @default(uuid())
  account          String    // model:<userId>
  userId           String
  status           String    // PENDING | APPROVED | REJECTED | EXPIRED
  providerRef      String    @unique
  clientToken      String    // token de sessão de curta duração (não é biometria)
  sessionExpiresAt DateTime  // validade da sessão no provedor (governa reuso)
  reason           String?   // motivo da rejeição
  createdAt        DateTime  @default(now())
  resolvedAt       DateTime?

  @@index([account])
  @@map("kyc_verifications")
}
```

`EXPIRED` é um status terminal reservado para o reaper futuro (ver §1 fora-de-escopo);
este subsistema nunca seta EXPIRED — só PENDING/APPROVED/REJECTED.

`kyc_status` (já existente) permanece como a flag-resultado lida pelo cash-out; este
subsistema a escreve. Sem FK (consistente com o padrão string-loose-coupling do projeto).

## 5. Componentes (arquitetura)

```
kyc-verification/
  kyc-verification.port.ts       KycVerificationProvider (porta) + KYC_VERIFICATION_PROVIDER token
                                 createSession(account): Promise<{ providerRef, clientToken, expiresAt: Date }>
  fake-kyc-verification.adapter.ts   fake p/ testes (gera providerRef/clientToken; sem rede)
  real-kyc-verification.adapter.ts   adaptador real (stub plugável; lê credenciais de env)
  kyc-signature.validator.ts     HMAC-SHA256 do corpo cru (molde do PspSignatureValidator)
  kyc-verification.service.ts    start(account,userId), applyResult(providerRef, outcome, reason?)
  kyc-verification.controller.ts POST /kyc/start, GET /kyc/me  (JwtAuthGuard + @Roles('MODEL'))
  kyc-webhook.controller.ts      POST /webhooks/kyc  (assinatura HMAC; sem guard de papel)
  kyc-verification.module.ts
```

Reusa: `KycModule`/`kyc_status` (escreve via PrismaService), `UsersService.setStatus`
(promoção a ACTIVE), `JwtAuthGuard`/`RolesGuard` (Identidade).

## 6. Fluxos

### 6.1 Iniciar verificação (`POST /kyc/start`)
Guards: `JwtAuthGuard` + `@Roles('MODEL')`. `req.user` traz `{id, role, status}`.
1. `account = model:<userId>`. Se `kyc_status.approved` já é `true` → 409 (já aprovada).
2. **Reuso:** busca a `KycVerification` PENDING mais recente da conta com
   `sessionExpiresAt > agora`. Se existir, retorna o `clientToken` dela (sem chamar o
   provedor) → `{ verificationId, clientToken, status: 'PENDING' }`. Fim.
3. Senão: `provider.createSession(account)` → `{ providerRef, clientToken, expiresAt }`.
4. Cria `KycVerification` PENDING com `providerRef`, `clientToken`, `sessionExpiresAt = expiresAt`.
5. Retorna `{ verificationId, clientToken, status: 'PENDING' }`.

### 6.2 Resultado do provedor (`POST /webhooks/kyc`)
Sem guard de papel; autenticado por assinatura.
1. Valida assinatura HMAC do corpo cru (header `x-kyc-signature`). Inválida/ausente → 401.
2. Lê `{ providerRef, outcome: 'APPROVED'|'REJECTED', reason? }`. Acha a `KycVerification`
   por `providerRef`. Não encontrada → 200 `{ received: true }` (ignora sem vazar).
3. Se a verificação já está resolvida (APPROVED/REJECTED) → 200 no-op (idempotente).
4. **APPROVED** → numa transação:
   - `KycVerification.status = APPROVED`, `resolvedAt = now`.
   - `kyc_status` upsert `{ account, approved: true }`.
   - lê o usuário; se `status === PENDING_VERIFICATION` → `setStatus(userId, 'ACTIVE')`;
     se `SUSPENDED` → não altera o status do usuário.
5. **REJECTED** → `KycVerification.status = REJECTED`, `resolvedAt = now`, `reason` gravado.
   (Não altera `kyc_status` nem o usuário; a modelo pode iniciar nova verificação.)
6. Retorna 200 `{ received: true }`.

### 6.3 Consultar (`GET /kyc/me`)
Guards: `JwtAuthGuard` + `@Roles('MODEL')`. Retorna a verificação mais recente da modelo
(`{ status, reason?, createdAt, resolvedAt? }`) ou `{ status: 'NONE' }` se nunca iniciou.

## 7. Tratamento de erros

- 401: assinatura de webhook inválida/ausente; requisição não autenticada nos endpoints com guard.
- 403: papel não-MODEL no `/kyc/start` ou `/kyc/me`.
- 409: modelo já aprovada tenta iniciar de novo.
- 200 (no-op): webhook de `providerRef` desconhecido; webhook redelivered de verificação já resolvida.
- Boot falha se `KYC_WEBHOOK_SECRET` ausente.

## 8. Testes (integração, contra Postgres real + FakeKycVerificationProvider)

1. MODEL inicia KYC → cria `KycVerification` PENDING e retorna `clientToken`.
2. CLIENT no `/kyc/start` → 403.
3. Modelo já aprovada (`kyc_status.approved=true`) iniciando de novo → 409.
3b. **Reuso de sessão:** chamar `/kyc/start` duas vezes seguidas (sessão ainda válida)
    retorna o MESMO `clientToken`/`providerRef`, cria só UMA linha PENDING, e o provedor
    (fake) tem `createSession` chamado UMA vez só. Quando a sessão expira
    (`sessionExpiresAt < agora`), um novo `/kyc/start` cria uma nova sessão.
4. Webhook APPROVED → verificação APPROVED, `kyc_status.approved=true`, usuário
   `PENDING_VERIFICATION → ACTIVE`.
5. Webhook APPROVED com usuário `SUSPENDED` → `kyc_status.approved=true` mas usuário
   permanece `SUSPENDED` (admin vence).
6. Webhook REJECTED → verificação REJECTED com `reason`; nova chamada a `/kyc/start`
   cria uma nova verificação PENDING (reenvio permitido).
7. Webhook com assinatura inválida → 401; nada muda no banco.
8. Idempotência: redelivery de um webhook APPROVED não re-aplica (usuário/kyc_status
   inalterados na segunda vez; sem erro).
9. Webhook com `providerRef` desconhecido → 200 e nada muda.
10. `GET /kyc/me` retorna a verificação atual; `NONE` quando nunca iniciou.
11. `KycSignatureValidator` (unitário): aceita HMAC válido, rejeita inválido (tempo-constante).

## 9. Sequência de implementação (sugerida)
Schema → porta+fake+adaptador real (stub) → `KycSignatureValidator` → `KycVerificationService`
→ controller `/kyc/start`+`/kyc/me` → webhook controller → fios no módulo/app + suíte completa.
