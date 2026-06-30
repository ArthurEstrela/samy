# Spec — Painel admin (UI)

**Data:** 2026-06-29
**Status:** Design (execução autorizada — lote "B", sem credencial).
**Tipo:** Ferramenta de operação — admin lista usuários e ativa/suspende.
**Depende de:** Admin (activate/suspend prontos), Users, Auth (dev-login), Frontend.

---

## 1. Objetivo e escopo
O backend já ativa/suspende usuários (`POST /admin/users/:id/activate|suspend`, gated `ADMIN`), mas
não há (a) como **listar** os usuários pra agir, nem (b) **UI**. Esta fatia entrega: endpoint de
listagem, painel `/admin` (listar + ativar/suspender), e login dev como ADMIN pra alcançar o painel.

**No escopo:**
- Backend: `UsersService.listUsers(filter?)` + `GET /admin/users?role=&status=` (`@Roles('ADMIN')`).
  Estender `dev-login` pra aceitar `ADMIN` (subject `dev-admin`, status ACTIVE).
- Frontend: `useAdminUsers`/`useSetUserStatus`; `AdminPage` em `/admin` (gated por role ADMIN) com a
  lista e botões Ativar/Suspender; botão "Entrar como admin (dev)" na `LoginPage`.

**Fora de escopo:** paginação/busca; editar perfil/preço; ver ganhos de modelo; KYC manual; logs de
auditoria. (Follow-up.)

## 2. Constraints globais
- `GET /admin/users` é `@Roles('ADMIN')` (não-admin → 403). Resposta: `{ id, role, status, email,
  displayName, createdAt }[]` — admin é operador confiável (vê displayName/email; o invariante de
  anonimato é contra **clientes**, não admin). Ordenar por `createdAt` desc, `take` 200.
- Filtros opcionais por querystring `role` e `status` (valores livres; sem match → lista vazia).
- `dev-login` ADMIN só existe com `DEV_LOGIN='true'` e fora de produção (mesmo duplo-gate atual).
- Front `/admin` redireciona pra `/` se `user.role !== 'ADMIN'`.
- Ativar/Suspender reusa os endpoints existentes; sucesso invalida a lista (`['admin-users']`).
- `import type` em tipos; backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo.

## 3. Componentes
```
src/users/users.service.ts          + listUsers(filter?)                          [mod]
src/admin/admin.controller.ts       + GET /admin/users                            [mod]
src/auth/auth.controller.ts         dev-login aceita ADMIN                         [mod]
src/auth/auth.service.ts            devLogin trata ADMIN                           [mod]
test/admin.e2e-spec.ts (ou novo)    lista + filtro + 403                          [mod/novo]
web/src/types/api.ts                + AdminUser                                    [mod]
web/src/admin/useAdminUsers.ts                                                    [novo]
web/src/admin/useSetUserStatus.ts                                                 [novo]
web/src/admin/AdminPage.tsx         lista + ativar/suspender                       [novo]
web/src/auth/auth-context.tsx       devLogin aceita 'ADMIN'                        [mod]
web/src/auth/LoginPage.tsx          + botão admin (dev)                            [mod]
web/src/App.tsx                     + rota /admin                                  [mod]
web/src/admin/admin.test.tsx                                                      [novo]
```

## 4. Detalhes
### 4.1 Backend
- `CreateUserInput.role` e `devLogin` passam a aceitar `'ADMIN'`; `createUser` status: ADMIN→ACTIVE.
  `devLogin('ADMIN')`: subject `dev-admin`, email `dev-admin@samy.local`, nome `Admin Dev`; garante
  status ACTIVE.
- `listUsers(filter?: { role?: string; status?: string })` → `prisma.user.findMany({ where: {...},
  orderBy: { createdAt: 'desc' }, take: 200 })`.
- `GET /admin/users` no `AdminController` (já `@Roles('ADMIN')` na classe): lê `role`/`status` da
  query, chama `listUsers`, mapeia pra `{ id, role, status, email, displayName, createdAt }`.

### 4.2 Frontend
- `AdminUser { id; role; status; email; displayName; createdAt }`.
- `useAdminUsers(filter?)` → `useQuery(['admin-users', filter], GET /admin/users?...)`.
- `useSetUserStatus()` → `useMutation(POST /admin/users/:id/(activate|suspend))`, `onSuccess`
  invalida `['admin-users']`.
- `AdminPage`: se `role !== 'ADMIN'` → `<Navigate to="/" />`. Senão, tabela/lista (displayName,
  email, role, selo de status) + botão **Ativar** (quando status ≠ ACTIVE) ou **Suspender** (quando
  ACTIVE). Vazio → "Nenhum usuário.".
- `LoginPage`: com `devEnabled`, botão "Entrar como admin (dev)" → `devLogin('ADMIN')` → `/admin`.
- `App.tsx`: rota `/admin` (ProtectedRoute → AdminPage).

## 5. Erros
- `GET /admin/users` sem token → 401; role não-ADMIN → 403. Ativar/Suspender inexistente → 404
  (já tratado no backend) → toast/linha de erro simples.

## 6. Testes
- **Backend e2e:** admin lista usuários (inclui um MODEL PENDING e um CLIENT); filtro `?status=
  PENDING_VERIFICATION` retorna só o modelo; não-admin → 403; `dev-login` ADMIN retorna user ADMIN.
- **Frontend:** `AdminPage` lista usuários e clicar "Ativar" chama `POST /admin/users/:id/activate`;
  role não-ADMIN redireciona (não mostra a lista).
- `npm run build` verde; `npx tsc --noEmit` verde.

## 7. Verificação manual
Dev: "Entrar como admin" → `/admin` lista os seeds; ativar um modelo PENDING o deixa ACTIVE (e ele
passa a aparecer na descoberta); suspender remove da descoberta.

## 8. Sequência
Backend (listUsers + GET /admin/users + dev-login ADMIN) + e2e → front (hooks + AdminPage + login +
rota) + testes → verificação.
