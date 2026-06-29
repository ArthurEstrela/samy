# Presentes (Gifts) UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cliente envia presente pra modelo a partir do perfil; tipos de presente semeados pro demo.

**Architecture:** A API de gifts já existe (`GET /gifts/catalog`, `POST /gifts`). Só falta semear `GiftType` e construir a UI (catálogo + enviar) no perfil da modelo.

**Tech Stack:** Prisma (seed); React/Vite, TanStack Query, Vitest.

## Global Constraints

- `GET /gifts/catalog` (autenticado) → `GiftType[]` ativos; `POST /gifts` (`@Roles('CLIENT')`) `{modelId, giftTypeId}` — 402 (saldo) / 404 (inativo/não-modelo) sobem.
- Não alterar a API de gifts. Enviar com sucesso → invalida `['balance']`.
- Erros: 402 → "Saldo insuficiente — recarregue." (+ link `/wallet`); 404 → "Presente indisponível.".
- `import type` em tipos. Backend `npx tsc --noEmit` limpo; front `npm run build` (tsc -b) limpo. Front testa com boundary mockado.

---

## Task 1: Seed de GiftTypes

**Files:**
- Modify: `prisma/seed-demo.ts`

**Interfaces:**
- Produces: ~4 GiftTypes (ids fixos) no DB de dev.

- [ ] **Step 1: Adicionar o seed de gifts**

In `prisma/seed-demo.ts`, inside `main()` after the models loop (and before the OCUPADA/presence block, or right after the profiles loop), add:
```ts
    const GIFTS = [
      { id: 'gift-rosa', name: 'Rosa', price: '5.00' },
      { id: 'gift-beijo', name: 'Beijo', price: '10.00' },
      { id: 'gift-coracao', name: 'Coração', price: '25.00' },
      { id: 'gift-coroa', name: 'Coroa', price: '50.00' },
    ];
    for (const g of GIFTS) {
      await prisma.giftType.upsert({
        where: { id: g.id },
        update: { name: g.name, priceCredits: new Prisma.Decimal(g.price), active: true },
        create: { id: g.id, name: g.name, priceCredits: new Prisma.Decimal(g.price), active: true },
      });
    }
```
And update the final `console.log` summary to mention `+ ${GIFTS.length} presentes`.

- [ ] **Step 2: Verificar que compila**

Run: `npx tsc --noEmit`
Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add prisma/seed-demo.ts
git commit -m "feat(dev): seed de tipos de presente (Rosa/Beijo/Coração/Coroa)"
```

---

## Task 2: Frontend — GiftPicker no perfil

**Files:**
- Modify: `web/src/types/api.ts`, `web/src/profile/ModelProfilePage.tsx`
- Create: `web/src/gifts/useGiftCatalog.ts`, `useSendGift.ts`, `GiftPicker.tsx`, `gifts.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`. Produces: `<GiftPicker modelId>`; `useGiftCatalog()`, `useSendGift()`; tipo `GiftType`.

- [ ] **Step 1: Tipo GiftType**

In `web/src/types/api.ts`, add:
```ts
export interface GiftType { id: string; name: string; priceCredits: string; active: boolean; }
```

- [ ] **Step 2: Escrever os testes (falham)**

Create `web/src/gifts/gifts.test.tsx`:
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { GiftPicker } from './GiftPicker';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
const catalog = [{ id: 'gift-rosa', name: 'Rosa', priceCredits: '5.00', active: true }, { id: 'gift-coroa', name: 'Coroa', priceCredits: '50.00', active: true }];
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('GiftPicker', () => {
  it('lista o catálogo e enviar chama POST /gifts', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/gifts/catalog')) return Promise.resolve(json(200, catalog));
      if (u.endsWith('/gifts') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'g1' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<GiftPicker modelId="m1" />));
    await waitFor(() => expect(screen.getByText('Rosa')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /rosa/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/gifts') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({ modelId: 'm1', giftTypeId: 'gift-rosa' });
    });
    await waitFor(() => expect(screen.getByText(/enviado/i)).toBeInTheDocument());
  });

  it('402 mostra saldo insuficiente', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/gifts/catalog')) return Promise.resolve(json(200, catalog));
      if (u.endsWith('/gifts') && init?.method === 'POST') return Promise.resolve(json(402, { message: 'insufficient balance' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<GiftPicker modelId="m1" />));
    await waitFor(() => expect(screen.getByText('Rosa')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /rosa/i }));
    await waitFor(() => expect(screen.getByText(/saldo insuficiente/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run (in `web/`): `npx vitest run src/gifts/gifts.test.tsx`
Expected: FAIL — `GiftPicker` não existe.

- [ ] **Step 4: Hooks**

Create `web/src/gifts/useGiftCatalog.ts`:
```ts
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { GiftType } from '../types/api';

export function useGiftCatalog(): ReturnType<typeof useQuery<GiftType[]>> {
  return useQuery<GiftType[]>({
    queryKey: ['gift-catalog'],
    queryFn: () => apiFetch<GiftType[]>('/gifts/catalog', { auth: true }),
  });
}
```

Create `web/src/gifts/useSendGift.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';

export function useSendGift(): ReturnType<typeof useMutation<unknown, Error, { modelId: string; giftTypeId: string }>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { modelId: string; giftTypeId: string }>({
    mutationFn: (dto) => apiFetch('/gifts', { method: 'POST', body: dto, auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['balance'] }); },
  });
}
```

- [ ] **Step 5: GiftPicker**

Create `web/src/gifts/GiftPicker.tsx`:
```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../lib/api-client';
import { useGiftCatalog } from './useGiftCatalog';
import { useSendGift } from './useSendGift';

export function GiftPicker({ modelId }: { modelId: string }): JSX.Element {
  const { data } = useGiftCatalog();
  const send = useSendGift();
  const [sentName, setSentName] = useState<string | null>(null);

  const errorMsg = (): string | null => {
    const e = send.error;
    if (!e) return null;
    if (e instanceof ApiError && e.status === 402) return 'Saldo insuficiente — recarregue.';
    if (e instanceof ApiError && e.status === 404) return 'Presente indisponível.';
    return 'Não foi possível enviar.';
  };
  const insufficient = send.error instanceof ApiError && send.error.status === 402;

  return (
    <section className="mt-6 rounded-2xl bg-velvet p-6">
      <p className="text-mist text-sm">Presentes</p>
      {data && data.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {data.map((g) => (
            <button
              key={g.id}
              type="button"
              disabled={send.isPending}
              onClick={() => { setSentName(g.name); send.mutate({ modelId, giftTypeId: g.id }); }}
              className="rounded-xl bg-void p-4 text-center hover:ring-1 hover:ring-ember disabled:opacity-50"
            >
              <p className="text-cream">{g.name}</p>
              <p className="mt-1 font-mono text-sm text-gold">⌗ {g.priceCredits}</p>
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-mist text-sm">Nenhum presente disponível.</p>
      )}
      {send.isSuccess && <p className="mt-3 text-gold text-sm">{sentName} enviado ✓</p>}
      {errorMsg() && (
        <p className="mt-3 text-ember text-sm">
          {errorMsg()}{' '}
          {insufficient && <Link to="/wallet" className="underline">Carteira</Link>}
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Wire no ModelProfilePage**

In `web/src/profile/ModelProfilePage.tsx`, import `GiftPicker` and render it (após o bloco de botões favoritar/chamada, ainda dentro do `<main>` da modelo encontrada):
```tsx
import { GiftPicker } from '../gifts/GiftPicker';
```
```tsx
      <GiftPicker modelId={model.userId} />
```

- [ ] **Step 7: Rodar e ver passar**

Run (in `web/`): `npx vitest run src/gifts/gifts.test.tsx`
Expected: PASS (2/2). Depois `npx vitest run` (suíte inteira) verde.

- [ ] **Step 8: build + commit**

Run (in `web/`): `npm run build` → limpo.
```bash
git add web/src/types/api.ts web/src/gifts web/src/profile/ModelProfilePage.tsx
git commit -m "feat(web): presentes — catálogo + enviar presente no perfil"
```

---

## Task 3: Verificação final + push

- [ ] **Step 1:** (in `web/`) `npx vitest run` e `npm run build` → verdes.
- [ ] **Step 2:** `npx tsc --noEmit` (raiz) → limpo (seed compila).
- [ ] **Step 3 (manual):** seed (`npm run seed:demo`) → cliente no perfil de modelo → Presentes → enviar → "enviado ✓" + saldo cai; sem saldo → "Saldo insuficiente".
- [ ] **Step 4:** `git push origin main`.

---

## Self-Review (autor)

**Cobertura do spec:** §4.1 seed GiftTypes → T1; §4.2 hooks + GiftPicker + wire → T2; §6 testes (lista/enviar/402) → T2; §7 manual → T3.

**Consistência de tipos:** `GiftType {id,name,priceCredits,active}` casa com o backend; `POST /gifts {modelId,giftTypeId}`; `ApiError.status` 402/404 mapeado. Rotas `/gifts/catalog`, `/gifts` idênticas.

**Placeholders:** nenhum — código/comando concreto. Gate de tipos do front = `npm run build`.
