# Spec — Frontend: Fundação + Porta de Entrada do Cliente

**Data:** 2026-06-28
**Status:** Design aprovado (aguardando revisão final do usuário)
**Tipo:** Primeira fatia do frontend web (SPA) consumindo a API NestJS existente.
**Depende de:** Backend Samy (auth `/auth/google` + `/auth/refresh`, discovery `/models`, `/favorites`).

---

## 1. Objetivo e escopo

O backend está completo, mas nada é visível/usável sem UI. Esta é a **primeira fatia** do
frontend: a **fundação** (scaffold, client de API, sessão, rotas, design base) + a **porta de
entrada do cliente** (login → descoberta → perfil da modelo). É a tela mais visível, exercita a
stack ponta-a-ponta contra a API real, e não depende do LiveKit.

O frontend inteiro é grande demais pra um spec; cada frente (carteira, chamada, painel da
modelo, admin) vira seu próprio spec→plano→exec depois. Esta fatia entrega software funcional e
testável por si só.

**Decisões fechadas (brainstorm):**
- **Stack:** Vite + React + TypeScript (SPA). Não Next: o app é 100% atrás de login, adulto, com
  anonimato como valor — SSR/SEO não se aplica; o backend já existe (Next viraria camada
  redundante); auth é client-token. Next fica reservado pra um eventual site de marketing público
  ou um BFF de segurança (fora de escopo).
- **Roteamento:** React Router. **Estado de servidor:** TanStack Query. **Estilo:** Tailwind CSS.
- **Local:** pasta `web/` no mesmo repositório (monorepo ao lado do backend).

**No escopo:**
- Scaffold Vite/React/TS em `web/`.
- Client de API tipado (base `VITE_API_URL`, `Authorization: Bearer`, refresh-no-401 com rotação).
- Sessão + `AuthProvider` (login/logout/user), persistência em `localStorage`.
- `/login` com Google Identity Services (`VITE_GOOGLE_CLIENT_ID`) → `POST /auth/google {idToken, role:'CLIENT'}`.
- Rotas protegidas (redireciona pra `/login` sem sessão).
- `/` Descoberta: `GET /models` → cards (stageName, badge de status, preço/min, tags), loading/vazio/erro, paginação.
- `/models/:id` Perfil: `GET /models/:id`, favoritar (`POST`/`DELETE /favorites/:id`), botão "Iniciar chamada" desabilitado ("em breve").
- Direção visual premium/intimista (tema escuro), aplicada no build.
- Testes de componente/unidade (Vitest + Testing Library) mockando o boundary de API.

**Fora de escopo (follow-up):**
- Carteira/recarga, experiência de chamada (LiveKit), painel da modelo, admin.
- Atualização de presença em tempo real (mostramos o status no carregamento; live depois).
- BFF/cookie httpOnly, SSR, i18n, site de marketing público (Next).
- Cadastro de modelo pelo front (esta fatia é client-side; role fixa `CLIENT` no login).

## 2. Constraints globais (vinculam todas as tasks)

- **Anonimato:** a UI nunca exibe `displayName` (nome real Google) — só `stageName`. Consome só os
  campos que o discovery expõe (que já omite o nome real).
- **Sessão:** `accessToken` + `refreshToken` + `user` de `/auth/google`. No `401`, tentar
  `/auth/refresh {refreshToken}` **uma vez** (rotação: guardar o novo refresh), retentar a request
  original; se o refresh falhar, limpar sessão e ir pra `/login`.
- **Toda rota autenticada** exige sessão; sem ela → `/login`.
- **Boota/builda/testa sem credencial:** os testes mockam o boundary de API (sem Google/backend
  real). O login *ao vivo* exige `VITE_GOOGLE_CLIENT_ID` (front) + `GOOGLE_CLIENT_ID` (backend).
- **TypeScript estrito**; `tsc --noEmit` limpo; lint limpo.
- **Não tocar no backend** nesta fatia (só consumir a API existente).
- Variáveis de ambiente do front via `import.meta.env.VITE_*`; nenhum segredo commitado
  (`.env` do front é gitignored; `.env.example` documenta as chaves).

## 3. Arquitetura e componentes

```
web/
  index.html
  package.json, vite.config.ts, tsconfig.json, tailwind.config.ts, postcss.config.js
  .env.example                      VITE_API_URL, VITE_GOOGLE_CLIENT_ID
  src/
    main.tsx                        bootstrap (QueryClientProvider, Router, AuthProvider)
    App.tsx                         rotas
    lib/
      api-client.ts                 fetch tipado + injeção de token + refresh-no-401
      session.ts                    leitura/escrita da sessão em localStorage
    auth/
      auth-context.tsx              AuthProvider + useAuth (user/login/logout)
      ProtectedRoute.tsx            redireciona pra /login sem sessão
      LoginPage.tsx                 botão Google Identity Services
    discovery/
      DiscoveryPage.tsx             lista de modelos (TanStack Query)
      ModelCard.tsx                 card individual
      StatusBadge.tsx               ONLINE/OCUPADA/OFFLINE
      useModels.ts                  query GET /models (limit/offset)
    profile/
      ModelProfilePage.tsx          perfil + favoritar + botão chamada (disabled)
      useModel.ts, useFavorite.ts   queries/mutations
    types/api.ts                    tipos das respostas (ModelCard, Profile, AuthResult, etc.)
    ui/                             primitivos (Button, Spinner, Skeleton) + tema
```

### 3.1 Client de API (`lib/api-client.ts`)
- `apiFetch<T>(path, opts)`: prefixa `VITE_API_URL`, injeta `Authorization: Bearer <access>` se há sessão,
  `Content-Type: application/json`.
- Em `401`: se há `refreshToken`, chama `POST /auth/refresh {refreshToken}` (uma vez), persiste os
  novos tokens, e retenta a request original uma vez. Se o refresh falhar (ou já era a 2ª tentativa),
  limpa a sessão e propaga um erro de "não autenticado" (o router manda pra `/login`).
- Erros HTTP viram `ApiError { status, message }`.

### 3.2 Sessão (`lib/session.ts`)
- `getSession(): Session | null`, `setSession(s)`, `clearSession()` em `localStorage` (chave `samy.session`).
- `Session = { accessToken: string; refreshToken: string; user: AuthUser }`.

### 3.3 Auth (`auth/`)
- `AuthProvider` lê a sessão no boot; expõe `user`, `login(idToken)`, `logout()`.
  `login` → `POST /auth/google {idToken, role:'CLIENT'}` → `setSession` → estado. `logout` →
  `POST /auth/logout {refreshToken}` (best-effort) → `clearSession`.
- `LoginPage`: renderiza o botão do Google Identity Services configurado com `VITE_GOOGLE_CLIENT_ID`;
  no callback de credencial chama `login(idToken)` e navega pra `/`. Se `VITE_GOOGLE_CLIENT_ID`
  ausente, mostra um aviso claro ("login não configurado") em vez de quebrar.
- `ProtectedRoute`: sem sessão → `<Navigate to="/login" />`.

### 3.4 Descoberta (`discovery/`)
- `useModels({ limit, offset })` → `GET /models?limit=&offset=` (já ordenado online→ocupada→offline
  no backend). Estados loading (skeletons), erro (retry), vazio.
- `ModelCard`: stageName, `StatusBadge`, preço/min, tags; clique → `/models/:id`.
- Paginação simples (botão "carregar mais" ou prev/next via offset).

### 3.5 Perfil (`profile/`)
- `useModel(id)` → `GET /models/:id`. Render: stageName, tags, preço, presença, (preview de voz se o
  payload trouxer). `useFavorite`: `POST`/`DELETE /favorites/:id` (otimista, invalida a query).
- Botão "Iniciar chamada" **desabilitado** com rótulo "em breve" (fatia futura).

## 4. Fluxo de dados
```
/login → GIS → idToken → POST /auth/google → {accessToken, refreshToken, user} → localStorage → /
/ (ProtectedRoute) → useModels → GET /models (Bearer) → cards
clique no card → /models/:id → useModel → GET /models/:id → perfil + favoritar
401 em qualquer request → /auth/refresh (rotação) → retry; se falhar → limpa sessão → /login
```

## 5. Tratamento de erros
- Sem `VITE_GOOGLE_CLIENT_ID`: `/login` mostra aviso de "login não configurado" (não quebra o app).
- `401` → fluxo de refresh; refresh falho → `/login`.
- Erro de rede/5xx nas queries → estado de erro com botão "tentar de novo".
- `GET /models/:id` 404 → tela "modelo não encontrada".
- Favoritar falho → reverte o otimismo + toast de erro.

## 6. Testes (Vitest + React Testing Library, boundary de API mockado)
- **api-client:** injeta `Authorization` quando há sessão; no `401` chama `/auth/refresh`, persiste
  os novos tokens e retenta uma vez; refresh falho → limpa sessão e sinaliza não-autenticado (sem loop).
- **AuthProvider:** `login` persiste sessão e popula `user`; `logout` limpa.
- **ProtectedRoute:** sem sessão → redireciona pra `/login`; com sessão → renderiza o filho.
- **DiscoveryPage:** renderiza cards do mock; estados loading/vazio/erro; ordem preservada do backend.
- **StatusBadge:** mapeia ONLINE/OCUPADA/OFFLINE pro rótulo/estilo certo.
- **ModelProfilePage:** favoritar chama `POST/DELETE /favorites/:id`; botão "Iniciar chamada" está disabled.
- `tsc --noEmit` limpo; lint limpo. (Sem e2e com Google real nesta fatia — manual depois das chaves.)

## 7. Verificação manual (pós-credencial)
Com `VITE_API_URL` apontando pro backend e `VITE_GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_ID` configurados:
`npm run dev` no `web/`, logar com Google, ver a lista de modelos e um perfil. (Documentado no
README do front; não é gate automatizado.)

## 8. Sequência de implementação (sugerida)
Scaffold (`web/` Vite+React+TS+Tailwind+Router+Query) → tipos + client de API (refresh-no-401) +
sessão → AuthProvider + LoginPage (GIS) + ProtectedRoute → Descoberta (useModels + cards + estados)
→ Perfil (useModel + favoritar + botão disabled) → polimento visual (skill frontend-design) +
README + verificação.
