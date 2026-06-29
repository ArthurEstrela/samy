# Spec — Carteira / Recarga do Cliente (front + endpoints)

**Data:** 2026-06-28
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Fatia de produto — fecha visualmente o cash-in (saldo + recarga PIX).
**Depende de:** Cash-in PIX (createRecharge/confirmRecharge), Ledger (getBalance), Auth, Frontend (fundação + sessão).

---

## 1. Objetivo e escopo

O cliente já loga e navega, mas não tem como **ver saldo** nem **colocar créditos** pela UI — e
não existe endpoint de saldo. Esta fatia entrega a jornada de recarga: ver saldo → adicionar
créditos → pagar (QR PIX) → saldo sobe.

Como em dev não há webhook real do PSP, incluímos um **confirmador dev-only** pra o fluxo ser
completável localmente (mesma dupla-trava do dev-login).

**No escopo:**
- Backend: `GET /wallet/balance` (CLIENT) e `POST /wallet/recharge/:id/dev-confirm` (dev-only).
- Frontend: página `/wallet` (saldo + criar recarga + QR + polling até PAID + botão dev de simular),
  e saldo+link no header da descoberta.

**Fora de escopo (follow-up):**
- Histórico/listagem de recargas (precisa de outro endpoint).
- Recarga real (depende de PSP); botão dev de simular é só desenvolvimento.
- Estorno; expiração ativa de recargas PENDING.

## 2. Constraints globais

- `GET /wallet/balance` exige `@Roles('CLIENT')`; retorna `{ balance: string }` de
  `LedgerService.getBalance('client:<req.user.id>')` (string decimal).
- `POST /wallet/recharge/:id/dev-confirm` só responde com `process.env.DEV_LOGIN === 'true'` E
  `process.env.NODE_ENV !== 'production'`; senão `404`. A recarga precisa pertencer ao usuário
  autenticado (senão `404`); confirma via `confirmRecharge(recharge.pspChargeId, recharge.amount)`.
- O botão "Já paguei (simular)" só aparece quando `VITE_DEV_LOGIN === 'true'`.
- Anonimato e sessão seguem as constraints já existentes do front (refresh-no-401, etc.).
- Front builda/testa sem credencial (boundary de API mockado); backend `npm run build` limpo;
  front `npm run build` limpo.
- Não alterar lógica financeira existente; `confirmRecharge` é reusado tal como está.

## 3. Componentes

```
src/wallet/wallet-balance.controller.ts   GET /wallet/balance (CLIENT)            [novo]
src/wallet/recharge.controller.ts         + POST :id/dev-confirm (dev-only)       [mod]
src/wallet/wallet.module.ts               + WalletBalanceController                [mod]
test/wallet.balance.e2e-spec.ts           e2e do saldo                            [novo]
test/wallet.dev-confirm.e2e-spec.ts       e2e do dev-confirm (on/off)             [novo]

web/src/wallet/useBalance.ts              GET /wallet/balance (Query)             [novo]
web/src/wallet/useCreateRecharge.ts       POST /wallet/recharge (mutation)        [novo]
web/src/wallet/useRecharge.ts             GET /wallet/recharge/:id (poll)         [novo]
web/src/wallet/WalletPage.tsx             saldo + recarga + QR + polling          [novo]
web/src/wallet/RechargePanel.tsx          formulário + QR + status                [novo]
web/src/App.tsx                           + rota /wallet                          [mod]
web/src/discovery/DiscoveryPage.tsx       header com saldo + link Carteira        [mod]
web/src/wallet/wallet.test.tsx            testes de componente                    [novo]
web/package.json                          + qrcode.react                          [mod]
```

## 4. Detalhes

### 4.1 Backend — saldo
`WalletBalanceController` (`@Controller('wallet')`, `@UseGuards(JwtAuthGuard, RolesGuard)`):
```ts
@Get('balance')
@Roles('CLIENT')
async balance(@Req() req): Promise<{ balance: string }> {
  const b = await this.ledger.getBalance(`client:${req.user.id}`);
  return { balance: b.toString() };
}
```
Injeta `LedgerService` (WalletModule já importa LedgerModule). Registrar no `WalletModule`.

### 4.2 Backend — dev-confirm
Em `RechargeController`, rota dev-only:
```ts
@Post(':id/dev-confirm')
async devConfirm(@Req() req, @Param('id') id): Promise<unknown> {
  if (process.env.DEV_LOGIN !== 'true' || process.env.NODE_ENV === 'production') throw new NotFoundException();
  const r = await this.prisma.recharge.findUnique({ where: { id } });
  if (!r || r.userId !== req.user.id) throw new NotFoundException('recharge not found');
  return this.wallet.confirmRecharge(r.pspChargeId ?? '', r.amount);
}
```
(RechargeController já injeta `WalletService` e `PrismaService`.)

### 4.3 Frontend — hooks
- `useBalance()` → `useQuery(['balance'], GET /wallet/balance, auth)`.
- `useCreateRecharge()` → mutation `POST /wallet/recharge {amount}` → retorna `{id, qrText, expiresAt, status}`.
- `useRecharge(id, enabled)` → `useQuery(['recharge', id], GET /wallet/recharge/:id, auth)` com
  `refetchInterval: 3000` enquanto status !== 'PAID' (e enabled).

### 4.4 Frontend — `WalletPage` / `RechargePanel`
- Saldo grande (mono, "créditos"); botão "Atualizar".
- `RechargePanel`: input de valor (validação ≥ MIN do front, ex.: 5) → cria recarga → mostra
  **QR** (`qrcode.react` a partir do `qrText`) + o copia-e-cola (com botão copiar) + status.
- Polling via `useRecharge`; ao virar PAID: invalida `['balance']`, mostra "Recarga confirmada"
  e o saldo novo.
- **Botão dev "Já paguei (simular)"** (se `VITE_DEV_LOGIN==='true'`) → `POST /wallet/recharge/:id/dev-confirm`
  → o polling pega PAID. Em prod o botão não existe.
- Estados: criando, aguardando pagamento, confirmado, erro (com retry).

### 4.5 Frontend — navegação
- Rota `/wallet` (protegida).
- Header da descoberta mostra `⌗ <saldo> créditos` (via `useBalance`) + link "Carteira" → `/wallet`.

## 5. Tratamento de erros
- `balance`/`recharge` com 401 → fluxo de refresh já existente; falha → `/login`.
- Valor inválido → 400 do backend já tratado; o front também valida antes de enviar.
- `dev-confirm` desligado → 404 (botão nem aparece sem `VITE_DEV_LOGIN`).
- Erro de criação de recarga (ex.: 503 PSP) → mensagem clara + retry.

## 6. Testes
- **Backend:** `GET /wallet/balance` reflete o saldo do ledger do cliente (semeia uma RECARGA, confere).
  `dev-confirm`: com `DEV_LOGIN=true` confirma uma recarga PENDING (saldo sobe, status PAID);
  desligado → 404; recarga de outro usuário → 404.
- **Frontend (boundary mockado):** WalletPage mostra o saldo; criar recarga renderiza o QR +
  status PENDING; quando o GET da recarga retorna PAID, aparece confirmação e `['balance']` é
  invalidada; botão dev (com `VITE_DEV_LOGIN`) chama `/wallet/recharge/:id/dev-confirm`.
- Suíte backend e `npm run build` do front verdes.

## 7. Verificação manual (a meta)
Logado como teste → abrir "Carteira" → ver saldo → adicionar 20 créditos → ver o QR → clicar
"Já paguei (simular)" → status vira PAID e o saldo sobe pra 20.

## 8. Sequência de implementação (sugerida)
Backend saldo (+e2e) → backend dev-confirm (+e2e) → front hooks + WalletPage/RechargePanel + QR +
rota + teste → header da descoberta com saldo → verificação manual na stack que já está no ar.
