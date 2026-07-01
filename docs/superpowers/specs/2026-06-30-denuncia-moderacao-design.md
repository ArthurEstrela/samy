# Spec — Denúncia & Moderação

**Data:** 2026-06-30
**Status:** Design (execução autorizada — pivot companhia sensual não-explícita).
**Tipo:** Segurança/anti-deriva — usuários denunciam violações; admin revê e age.
**Depende de:** Users, Admin (suspend pronto), Frontend, KYC.

---

## 1. Objetivo e escopo
A [Política de Uso](../../politica-de-uso.md) define a linha; falta o mecanismo pra **fazer valer**.
Esta fatia entrega: qualquer usuário **denuncia** uma conta/chamada; o **admin** vê as denúncias
abertas e resolve (revisado/descartado), agindo com o **suspender** que já existe. É o que segura a
deriva pro explícito e o que dá credibilidade perante PSP/app store.

**No escopo:**
- Backend: model `Report` + migração; `POST /reports` (CLIENT ou MODEL); `GET /admin/reports`
  (ADMIN); `POST /admin/reports/:id/resolve` (ADMIN).
- Frontend: botão **Denunciar** com motivo no perfil da acompanhante; seção de denúncias no painel
  admin com resolver + atalho pra suspender.

**Fora de escopo (follow-up):** denúncia dentro da chamada em tempo real; reter saque automático de
conta denunciada (a Política prevê, mas fica pra depois); notificação por e-mail; anexos/evidência.

## 2. Constraints globais
- `POST /reports` exige autenticação (CLIENT ou MODEL). Não é possível **denunciar a si mesmo**; o
  `reportedUserId` deve existir. Um relato cria status `OPEN`.
- `GET /admin/reports` e `POST /admin/reports/:id/resolve` são `@Roles('ADMIN')` (não-admin → 403).
- `reason` é um enum de strings fixas: `EXPLICITO | ENCONTRO_FORA | ASSEDIO | MENOR | GOLPE | OUTRO`.
  `details` é opcional (texto curto).
- Anonimato preservado: a resposta ao admin usa `stageName`/`email` conforme já exposto no
  `/admin/users`; o denunciante e o denunciado nunca se veem via denúncia.
- Migração aditiva (nova tabela `reports`). `import type` em tipos; backend `npx tsc --noEmit`
  limpo; front `npm run build` limpo.

## 3. Componentes
```
prisma/schema.prisma                         + model Report                          [mod]
prisma/migrations/<ts>_reports/migration.sql                                          [novo]
src/reports/reports.service.ts               create + listOpen + resolve             [novo]
src/reports/reports.controller.ts            POST /reports                            [novo]
src/reports/admin-reports.controller.ts      GET/POST /admin/reports (ADMIN)          [novo]
src/reports/reports.module.ts                                                         [novo]
src/app.module.ts                            + ReportsModule                          [mod]
web/src/types/api.ts                         + ReportReason, AdminReport              [mod]
web/src/reports/useReport.ts                 mutation POST /reports                   [novo]
web/src/reports/ReportButton.tsx             botão + motivo, no perfil                [novo]
web/src/profile/ModelProfilePage.tsx         + <ReportButton/>                        [mod]
web/src/admin/useAdminReports.ts             query + resolve                          [novo]
web/src/admin/AdminPage.tsx                  + seção de denúncias                     [mod]
test/reports.e2e-spec.ts / web/src/reports/*.test.tsx / admin.test.tsx               [novo/mod]
```

## 4. Detalhes
### 4.1 Model
```
Report { id, reporterUserId, reportedUserId, callId?, reason, details?, status(OPEN|REVIEWED|DISMISSED, default OPEN), createdAt, resolvedAt? }
@@index([status]) @@index([reportedUserId])
```

### 4.2 Backend
- `ReportsService.create(reporterId, { reportedUserId, callId?, reason, details? })`: valida que
  `reportedUserId !== reporterId` (senão 400) e que o alvo existe (senão 404); cria `OPEN`.
- `ReportsService.listOpen(status?)`: `findMany` por status (default OPEN), desc por createdAt,
  take 200; enriquece com `stageName`/`email` do denunciado.
- `ReportsService.resolve(id, status)`: seta `REVIEWED|DISMISSED` + `resolvedAt`; 404 se não existe.
- `POST /reports` (`@Roles('CLIENT','MODEL')` ou apenas autenticado): cria.
- `GET /admin/reports?status=` e `POST /admin/reports/:id/resolve` (`@Roles('ADMIN')`).

### 4.3 Frontend
- `ReportReason` enum; `AdminReport { id, reportedUserId, reportedName, reason, details, status, createdAt }`.
- `useReport()` → `useMutation(POST /reports)`.
- `ReportButton({ reportedUserId })`: botão discreto "Denunciar" → abre um pequeno seletor de motivo
  (+ detalhe opcional) → envia; sucesso mostra "Denúncia enviada. Obrigado." Erros: 400 (self) e 404
  tratados com mensagem genérica.
- `ModelProfilePage`: `<ReportButton reportedUserId={model.userId} />` discreto no rodapé.
- `useAdminReports()` → query `['admin-reports']` + `resolve` mutation (invalida a lista).
- `AdminPage`: nova seção "Denúncias" listando abertas (nome do denunciado, motivo, detalhe, data) com
  **Revisado**/**Descartar** e atalho **Suspender** (reusa o setStatus existente).

## 5. Erros
- `POST /reports`: self → 400; alvo inexistente → 404; sem token → 401.
- `/admin/reports*`: não-admin → 403.

## 6. Testes
- **Backend e2e:** cliente denuncia acompanhante → OPEN criado; auto-denúncia → 400; alvo
  inexistente → 404; admin lista abertas e resolve (some da lista OPEN); não-admin → 403.
- **Frontend:** `ReportButton` envia `POST /reports` com `{reportedUserId, reason}` e mostra sucesso;
  `AdminPage` lista denúncias e "Revisado" chama o resolve.
- `npx tsc --noEmit` + `npm run build` verdes.

## 7. Verificação manual
Cliente abre um perfil → Denunciar → escolhe "conteúdo explícito" → envia. Admin entra em /admin →
seção Denúncias mostra o relato → Suspender a conta e/ou marcar Revisado.

## 8. Sequência
Model+migração+endpoints (T1) → botão de denúncia no perfil (T2) → seção admin de denúncias (T3).
