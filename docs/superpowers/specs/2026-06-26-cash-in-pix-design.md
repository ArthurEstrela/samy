# Spec — Cash-in PIX (criação de cobrança + reconciliação)

**Data:** 2026-06-26
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Feature de entrada de saldo — fecha o "como o cliente coloca dinheiro".
**Depende de:** Ledger (`postTransaction`), Auth (JwtAuthGuard/RolesGuard), o webhook PSP existente.

---

## 1. Objetivo e escopo

Hoje só existe o **lado da confirmação** do cash-in (`POST /webhooks/psp` credita o ledger no
`payment.confirmed`). Falta o **lado da criação**: o cliente não tem como iniciar uma recarga e
receber um QR PIX pra pagar, e não há persistência da recarga. Sem isso, ninguém coloca saldo —
e o taxímetro recém-ligado não tem o que cobrar.

Decisão fechada (usuário): **create-first + credita o valor persistido.** O cliente cria a
recarga, persistimos um `Recharge` PENDING com o valor pedido + o QR; o webhook casa o pagamento
com esse registro e credita o valor que NÓS pedimos (não o do payload).

**No escopo:**
- Model `Recharge` (recarga pendente persistida) + migração.
- `PspChargePort` (criar cobrança PIX) + `FakePspChargeAdapter` (dev/test) + `RealPspChargeAdapter`
  (default de produção, lança "not configured").
- `WalletService.createRecharge(userId, amount)` — persiste PENDING, chama o port, grava o QR.
- `WalletService.confirmRecharge(pspChargeId, eventAmount)` — casa, credita o valor persistido,
  marca PAID (idempotente).
- `RechargeController`: `POST /wallet/recharge` (CLIENT) + `GET /wallet/recharge/:id` (dono).
- Webhook (`WalletController`) passa a chamar `confirmRecharge`.
- `MIN_RECHARGE` (env, default `5.00`).

**Fora de escopo (follow-up):**
- HTTP real do provedor (Suitpay/Pushin) — depende da conta/docs; fica como `RealPspChargeAdapter`
  stub documentado.
- Expiração ativa de cobranças PENDING (sweeper) — um charge não pago só permanece PENDING.
- Histórico/listagem (`GET /wallet/recharges`).
- Reembolso/estorno de recarga.

## 2. Decisões fechadas

- **Credita o valor persistido** (`recharge.amount`), não `event.amount`. Webhook órfão
  (paymentId sem `Recharge`) ou com valor divergente → 200 sem creditar (loga). HMAC já autentica
  o PSP; isto adiciona defesa contra crédito arbitrário e dá histórico/status ao cliente.
- **Sem conta no PSP** → padrão port + fake (dev/test) + stub real que lança (produção). Nenhum
  `Fake*` é default de produção (mesma auditoria do payout/KYC).
- **Idempotência** do crédito por `recharge:<rechargeId>` no ledger + CAS de status
  (`updateMany where status=PENDING → PAID`), ambos na mesma `$transaction`.

## 3. Constraints globais (vinculam todas as tasks)

- O webhook credita **`recharge.amount`** (persistido), nunca `event.amount`. `event.amount`
  só é usado pra detectar divergência (mismatch → não credita).
- Crédito **idempotente**: dois `payment.confirmed` pro mesmo charge creditam uma vez só
  (CAS de status + grupo `recharge:<rechargeId>` no ledger, na mesma transação).
- **App boota sem o PSP de charge configurado**; `RealPspChargeAdapter` lança só quando usado.
  Nenhum `Fake*` é default de produção.
- **`createRecharge` valida** amount: decimal positivo com ≤2 casas e `>= MIN_RECHARGE` → senão
  `400`. Falha do PSP → `Recharge` vira `FAILED` + `503`.
- **Autorização:** `POST /wallet/recharge` exige `@Roles('CLIENT')`; `GET /wallet/recharge/:id`
  só retorna a recarga do próprio usuário (senão `404`).
- **Soma-zero:** o crédito posta `RECARGA` (+) e `RECARGA_OFFSET` (−) contra `source:external`
  (padrão já existente em `creditRecharge`).
- **`import type`** em interfaces injetadas; `npx tsc --noEmit` limpo. Migração UTF-8 sem BOM.
- Não quebrar o contrato HMAC nem a validação de payload já existentes no webhook.

## 4. Componentes

```
prisma/schema.prisma                         + model Recharge                         [mod]
prisma/migrations/<ts>_recharge/migration.sql  CREATE TABLE recharges                 [novo]
src/wallet/psp-charge.port.ts                PspChargePort + PSP_CHARGE_PORT token    [novo]
src/wallet/fake-psp-charge.adapter.ts        QR determinístico (dev/test)            [novo]
src/wallet/real-psp-charge.adapter.ts        stub que lança (default de produção)    [novo]
src/wallet/wallet.service.ts                 createRecharge + confirmRecharge        [mod]
                                             (remove creditRecharge — substituído)
src/wallet/recharge.controller.ts            POST /wallet/recharge, GET /:id          [novo]
src/wallet/wallet.controller.ts              webhook chama confirmRecharge            [mod]
src/wallet/wallet.module.ts                  + PrismaModule, Auth, port, controller   [mod]
.env.example                                 MIN_RECHARGE                             [mod]
test/wallet.recharge.spec.ts                 substitui testes de creditRecharge por  [mod]
                                             createRecharge + confirmRecharge + endpoint
test/wallet.webhook.e2e-spec.ts              testes de crédito → fluxo create-first;  [mod]
                                             HMAC/validação de payload mantidos
```

## 5. Detalhes

### 5.1 Schema `Recharge`
```prisma
model Recharge {
  id          String    @id @default(uuid())
  userId      String
  amount      Decimal   @db.Decimal(14, 2)
  status      String    @default("PENDING")  // PENDING | PAID | FAILED
  pspChargeId String?
  qrText      String?
  expiresAt   DateTime?
  createdAt   DateTime  @default(now())
  paidAt      DateTime?

  @@index([pspChargeId])
  @@index([userId])
  @@map("recharges")
}
```

### 5.2 `PspChargePort`
```ts
export const PSP_CHARGE_PORT = 'PSP_CHARGE_PORT';
export interface PspChargeInput { rechargeId: string; amount: string; payerUserId: string; }
export interface PspCharge { pspChargeId: string; qrText: string; expiresAt: Date; }
export interface PspChargePort { createCharge(input: PspChargeInput): Promise<PspCharge>; }
```
- `FakePspChargeAdapter`: retorna `{ pspChargeId: 'fake-charge:'+rechargeId, qrText: '000201...'+rechargeId, expiresAt: now+1h }`.
- `RealPspChargeAdapter`: `createCharge` lança `Error('PSP charge not configured')`. **Default do módulo.**

### 5.3 `WalletService.createRecharge(userId, amount)`
1. Valida `amount` (positivo, ≤2 casas, `>= MIN_RECHARGE`) → `BadRequestException`.
2. Cria `Recharge` PENDING → `id`.
3. `try`: `createCharge({ rechargeId, amount: amount.toString(), payerUserId: userId })` →
   `update` o Recharge com `pspChargeId/qrText/expiresAt`; retorna `{ id, amount, status, qrText, expiresAt }`.
4. `catch`: `update` status `FAILED`; lança `ServiceUnavailableException('payment provider unavailable')`.

`MIN_RECHARGE` lido como `new Prisma.Decimal(process.env.MIN_RECHARGE ?? '5.00')`.

### 5.4 `WalletService.confirmRecharge(pspChargeId, eventAmount): Promise<{ credited: boolean; reason?: string }>`
Numa `$transaction`:
1. `findFirst` Recharge por `pspChargeId`. Ausente → `{ credited:false, reason:'unknown' }`.
2. `status === 'PAID'` → `{ credited:false, reason:'already' }` (idempotente).
3. `eventAmount != recharge.amount` → `{ credited:false, reason:'amount_mismatch' }`.
4. CAS: `updateMany({ where:{ id, status:'PENDING' }, data:{ status:'PAID', paidAt: now } })`.
   Se `count !== 1` → `{ credited:false, reason:'already' }` (corrida).
5. `ledger.postTransaction('recharge:'+id, [RECARGA +amount em client:userId, RECARGA_OFFSET −amount em source:external], tx)`.
6. `{ credited:true }`.

### 5.5 Endpoints (`RechargeController`, `@Controller('wallet/recharge')`, `@UseGuards(JwtAuthGuard, RolesGuard)`)
- `POST /wallet/recharge` `@Roles('CLIENT')`, body `{ amount: string }` → `createRecharge(req.user.id, amount)`.
- `GET /wallet/recharge/:id` (qualquer autenticado): busca a recarga; se `userId !== req.user.id` → `NotFoundException`; senão `{ id, amount, status, qrText, expiresAt, paidAt }`.

### 5.6 Webhook (`WalletController.handle`)
A validação de payload existente (HMAC, `paymentId`/`userId`/`amount` não-vazios, `amount`
decimal positivo) é **mantida** inalterada. No `payment.confirmed` chama
`confirmRecharge(event.paymentId, new Prisma.Decimal(event.amount))` e responde `200 { received:true }`
independente do `reason` (órfão/mismatch/already não são erro de transporte — logar e ACK pra não
gerar retry infinito do PSP). **`event.userId` deixa de ser usado para creditar** — o crédito vai
para `client:<recharge.userId>` (o usuário persistido na recarga); a validação de `userId` no payload
permanece só por compatibilidade.

### 5.7 Module
`WalletModule`: importa `PrismaModule`, `LedgerModule`, `AuthModule`; controllers
`[WalletController, RechargeController]`; provê `WalletService`, `PspSignatureValidator` (factory
existente), `{ provide: PSP_CHARGE_PORT, useClass: RealPspChargeAdapter }`.

## 6. Tratamento de erros
- `createRecharge`: amount inválido/abaixo do mínimo → `400`; PSP indisponível → recarga `FAILED` + `503`.
- Webhook: HMAC inválido → `401` (inalterado); payload inválido → `400` (inalterado); órfão/mismatch
  → `200` sem creditar (loga); já PAID → `200` idempotente.
- `GET /:id` de outro usuário → `404` (não vaza existência).
- Boot não falha sem PSP de charge; `RealPspChargeAdapter` lança só ao criar cobrança.

## 7. Testes
- **`test/recharge.create.spec.ts`** (fake adapter via override):
  - cria recarga PENDING, persiste `pspChargeId/qrText/expiresAt`, retorna o QR.
  - amount abaixo de `MIN_RECHARGE` → `400`; amount não-positivo/3 casas → `400`.
  - PSP falha (adapter que lança) → recarga `FAILED`, resposta `503`.
  - `POST` sem role CLIENT → `403`; `GET /:id` de outro usuário → `404`; do dono → status correto.
- **`test/wallet.webhook.e2e-spec.ts`** (atualizado p/ create-first):
  - cria uma `Recharge` PENDING (com `pspChargeId` conhecido) e então `payment.confirmed`
    (HMAC válido) p/ esse paymentId → credita `recharge.amount`, marca PAID, saldo sobe;
    segundo webhook idêntico → sem duplo crédito (idempotente).
  - paymentId desconhecido → `200`, nada creditado.
  - valor divergente → `200`, nada creditado, recarga continua PENDING.
  - **Mantidos:** HMAC inválido → `401`; payload inválido (paymentId/userId/amount) → `400`;
    evento não-`payment.confirmed` → `200` sem creditar.
- Suíte completa permanece verde; `tsc` limpo. Auditoria: nenhum `Fake*` default.

## 8. Sequência de implementação (sugerida)
Schema `Recharge` + migração → `PspChargePort` + Fake + Real(stub) → `createRecharge` +
`RechargeController` (POST/GET) + module wiring + testes → `confirmRecharge` + troca no webhook +
testes → `.env.example` (MIN_RECHARGE) + suíte completa.
