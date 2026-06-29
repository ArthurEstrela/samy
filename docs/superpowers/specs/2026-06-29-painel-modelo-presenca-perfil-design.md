# Spec — Painel da Modelo #1: Presença & Perfil

**Data:** 2026-06-29
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Fatia de produto — lado da oferta (modelo se gerencia e fica descobrível).
**Depende de:** Auth/dev-login, Marketplace (`me/profile`, `me/heartbeat`), Frontend (fundação, sessão, design system).

---

## 1. Objetivo e escopo

Hoje modelos só existem via seed; não conseguem se gerenciar nem ficar online pela UI. Esta fatia
entrega o núcleo do painel da modelo: **logar como modelo → montar/editar o perfil → ficar online**
(aparecendo na descoberta de verdade). É a primeira de 3 sub-fatias do painel (as outras: ganhos/saque
e KYC).

**No escopo:**
- Backend: estender `POST /auth/dev-login` pra aceitar `{ role?: 'MODEL' }` (cria modelo dev ACTIVE).
- Frontend: auth de modelo (botão dev) + redirect por role + rota `/painel` (MODEL-only) com
  formulário de perfil (`me/profile`) e toggle de presença (`me/heartbeat`).

**Fora de escopo (próximas fatias):**
- Ganhos/saque da modelo (precisa endpoint novo).
- KYC (UI; backend já existe).
- Signup real de modelo via Google (produção segue CLIENT-only por ora).
- Upload de áudio de preview (o campo é uma URL por enquanto).

## 2. Constraints globais

- `POST /auth/dev-login` mantém a dupla-trava (`DEV_LOGIN==='true'` E `NODE_ENV!=='production'`).
  Com `{ role: 'MODEL' }` cria/usa um modelo dev (`provider 'dev'`, `subject 'dev-model'`) e garante
  `status: 'ACTIVE'` (atalho dev; sem KYC nesta fatia). Sem body / `role` ausente → CLIENT (comportamento atual).
- `/painel` exige sessão E `user.role === 'MODEL'`; um não-MODEL é redirecionado pra `/`.
- Após login: MODEL → `/painel`, CLIENT → `/` (redirect por role no ponto de chamada).
- O perfil usa os endpoints existentes **inalterados**: `GET /me/profile` (retorna o perfil ou null),
  `PUT /me/profile` (`UpsertProfileDto {stageName, bio?, pricePerMinute, tags?, voicePreviewUrl?}`).
- Presença: enquanto o toggle estiver ligado, o front manda `POST /me/heartbeat` na hora e a cada
  ~20s (TTL do backend = 30s); ao desligar/desmontar, para. Sem persistência além do TTL.
- Front builda/testa sem credencial (boundary mockado); `npm run build` (tsc -b) limpo. Anonimato:
  o `stageName` é o nome público; `displayName` nunca é exibido a terceiros (aqui é o próprio perfil, ok).

## 3. Componentes

```
src/auth/auth.service.ts        devLogin(role?: 'CLIENT'|'MODEL')           [mod]
src/auth/auth.controller.ts     dev-login lê body.role                      [mod]
test/auth.dev-login.e2e-spec.ts + caso role MODEL (ACTIVE)                  [mod]

web/src/types/api.ts            + ModelProfile type                         [mod]
web/src/auth/auth-context.tsx   devLogin(role?: 'CLIENT'|'MODEL')           [mod]
web/src/auth/LoginPage.tsx      + botão "Entrar como modelo (teste)"        [mod]
web/src/model/useProfile.ts     GET /me/profile                            [novo]
web/src/model/useUpsertProfile.ts PUT /me/profile (mutation)               [novo]
web/src/model/usePresence.ts    toggle + heartbeat loop                    [novo]
web/src/model/ProfileForm.tsx   formulário do perfil                       [novo]
web/src/model/PresenceToggle.tsx switch online                            [novo]
web/src/model/ModelDashboard.tsx página /painel (role-gate)                [novo]
web/src/App.tsx                 + rota /painel                             [mod]
web/src/model/model.test.tsx    testes de componente                       [novo]
```

## 4. Detalhes

### 4.1 Backend — dev-login com role
- `AuthService.devLogin(role: 'CLIENT' | 'MODEL' = 'CLIENT')`: provider `'dev'`, subject
  `role === 'MODEL' ? 'dev-model' : 'dev-client'`, email `dev-<role>@samy.local`. Cria via
  `createUser` se não existir; **se MODEL e status !== 'ACTIVE', `users.setStatus(id, 'ACTIVE')`**.
  Retorna `{ accessToken, refreshToken, user }` (mesmo shape).
- `AuthController.devLogin(@Body() body?: { role?: string })`: mantém a dupla-trava; chama
  `this.auth.devLogin(body?.role === 'MODEL' ? 'MODEL' : 'CLIENT')`.

### 4.2 Frontend — auth de modelo + redirect
- `auth-context`: `devLogin(role: 'CLIENT' | 'MODEL' = 'CLIENT')` → `POST /auth/dev-login` com body
  `{ role }` → `setSession` + `setUser`.
- `LoginPage` (quando `VITE_DEV_LOGIN==='true'`): além do botão de cliente, um botão **"Entrar como
  modelo (teste)"** → `devLogin('MODEL')` → navega pra `/painel`. O botão de cliente navega pra `/`.

### 4.3 Frontend — `/painel` (ModelDashboard)
- Protegida (`ProtectedRoute`) e **role-gate**: `const { user } = useAuth();` se
  `user?.role !== 'MODEL'` → `<Navigate to="/" replace />`.
- Header: stageName (ou "Seu perfil") + "sair".
- `ProfileForm`: carrega `GET /me/profile` (`useProfile`); campos stageName, bio (textarea),
  pricePerMinute (number), tags (input texto separado por vírgula ↔ array), voicePreviewUrl (opcional).
  Salva com `PUT /me/profile` (`useUpsertProfile`); estados: carregando, salvando, salvo, erro.
  Perfil novo (null) → formulário vazio.
- `PresenceToggle`: switch "Ficar online" via `usePresence()` — ligado dispara heartbeat imediato +
  `setInterval(20s)`; desligado/desmontado limpa. Mostra ONLINE/OFFLINE.

### 4.4 Hooks
- `useProfile()` → `useQuery(['my-profile'], GET /me/profile, auth)` (`ModelProfile | null`).
- `useUpsertProfile()` → `useMutation(PUT /me/profile, body)`, invalida `['my-profile']` no sucesso.
- `usePresence()` → `{ online: boolean; toggle: () => void }` com `useEffect` controlando o intervalo
  (POST `/me/heartbeat`); cleanup no unmount.

### 4.5 Tipo
`ModelProfile { userId: string; stageName: string; bio: string | null; pricePerMinute: string; tags: string[]; voicePreviewUrl: string | null }`.

## 5. Tratamento de erros
- Não-MODEL em `/painel` → redirect `/` (sem 403 feio).
- `GET/PUT /me/profile` 401 → fluxo de refresh existente. Erro de salvar → mensagem + retry.
- `dev-login` role inválido → tratado como CLIENT (default). Em prod a rota é 404 (dupla-trava).
- Heartbeat falho (rede) → loga/silencia; o toggle continua tentando no próximo tick (não derruba a UI).

## 6. Testes
- **Backend:** `POST /auth/dev-login {role:'MODEL'}` (com DEV_LOGIN=true) → `user.role==='MODEL'` e
  `user.status==='ACTIVE'`; chamadas repetidas reutilizam o mesmo modelo dev; sem role → CLIENT.
- **Frontend (boundary mockado):** ModelDashboard carrega o perfil no form e salvar chama
  `PUT /me/profile` com os campos (tags vira array); toggle de presença ligado chama
  `POST /me/heartbeat`; um usuário CLIENT em `/painel` é redirecionado.
- Suíte backend + `npm run build` do front verdes.

## 7. Verificação manual (a meta)
Na stack no ar: LoginPage → "Entrar como modelo (teste)" → `/painel` → preencher perfil (stageName,
preço, tags) → salvar → ligar "Ficar online" → abrir `/` noutra aba como cliente → ver a modelo
ONLINE com voiceprint pulsando.

## 8. Sequência de implementação (sugerida)
Backend dev-login role (+e2e) → front auth de modelo (devLogin role + botão + redirect) → hooks +
ProfileForm + PresenceToggle + ModelDashboard + rota /painel + testes → verificação manual.
