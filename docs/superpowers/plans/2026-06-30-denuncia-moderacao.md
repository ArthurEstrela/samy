# Denúncia & Moderação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usuários denunciam violações da Política de Uso; o admin vê as denúncias abertas e resolve, agindo com o suspender que já existe.

**Architecture:** Novo model `Report` + módulo `reports` com `POST /reports` (qualquer autenticado) e `GET/POST /admin/reports` (ADMIN). Frontend ganha botão Denunciar no perfil e uma seção de denúncias no painel admin.

**Tech Stack:** NestJS + Prisma + Postgres (back); Vite + React 18 + TanStack Query v5 + Vitest (front).

## Global Constraints
- `POST /reports` exige só `JwtAuthGuard` (qualquer autenticado). Não pode denunciar a si mesmo (400); alvo deve existir (404).
- `GET /admin/reports` e `POST /admin/reports/:id/resolve` são `@Roles('ADMIN')` (não-admin → 403).
- `reason` ∈ `EXPLICITO | ENCONTRO_FORA | ASSEDIO | MENOR | GOLPE | OUTRO`. `status` ∈ `OPEN | REVIEWED | DISMISSED` (default OPEN).
- Migração aditiva (tabela `reports`). `import type` em tipos. Backend gate `npx tsc --noEmit`. Front gate `npm run build`. e2e via `jest-integration.json` (Postgres de teste no ar; `npm run db:test:push` + `npx prisma generate` após schema).

---

### Task 1: Backend — model Report + endpoints

**Files:**
- Modify: `prisma/schema.prisma` (+ model `Report`)
- Create: `prisma/migrations/20260630000000_reports/migration.sql`
- Create: `src/reports/reports.service.ts`, `src/reports/reports.controller.ts`, `src/reports/admin-reports.controller.ts`, `src/reports/reports.module.ts`
- Modify: `src/app.module.ts` (+ `ReportsModule`)
- Test: `test/reports.e2e-spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `JwtAuthGuard`/`AuthUser`, `RolesGuard`/`Roles('ADMIN')`, `UsersService` (opcional pra validar alvo — pode usar prisma direto).
- Produces:
  - `ReportsService.create(reporterId, dto): Promise<Report>`
  - `ReportsService.listOpen(status?): Promise<AdminReportView[]>`
  - `ReportsService.resolve(id, status): Promise<Report>`
  - `POST /reports`, `GET /admin/reports?status=`, `POST /admin/reports/:id/resolve`

- [ ] **Step 1: Schema + migration**

Em `prisma/schema.prisma`, adicionar:
```prisma
model Report {
  id             String    @id @default(uuid())
  reporterUserId String
  reportedUserId String
  callId         String?
  reason         String
  details        String?
  status         String    @default("OPEN")
  createdAt      DateTime  @default(now())
  resolvedAt     DateTime?

  @@index([status])
  @@index([reportedUserId])
  @@map("reports")
}
```
Criar `prisma/migrations/20260630000000_reports/migration.sql`:
```sql
-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "reporterUserId" TEXT NOT NULL,
    "reportedUserId" TEXT NOT NULL,
    "callId" TEXT,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_status_idx" ON "reports"("status");

-- CreateIndex
CREATE INDEX "reports_reportedUserId_idx" ON "reports"("reportedUserId");
```

- [ ] **Step 2: Sync test DB + regenerate client**

Run: `npm run db:test:push && npx prisma generate`
Expected: tabela `reports` no banco de teste; client TS com `Report`.

- [ ] **Step 3: Write the failing e2e test**

Harness no estilo do `test/admin.e2e-spec.ts` (FakeIdentityProvider + promoção a ADMIN).

```ts
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { IDENTITY_PROVIDER } from '../src/identity/identity.port';
import { FakeIdentityProvider } from '../src/identity/fake-identity.adapter';

describe('Reports (e2e)', () => {
  let app: INestApplication; let prisma: PrismaService; let fake: FakeIdentityProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IDENTITY_PROVIDER).useClass(FakeIdentityProvider).compile();
    app = mod.createNestApplication({ rawBody: true }); await app.init();
    prisma = mod.get(PrismaService); fake = mod.get(IDENTITY_PROVIDER);
  });
  beforeEach(async () => { fake.reset(); await prisma.report.deleteMany(); await prisma.refreshToken.deleteMany(); await prisma.user.deleteMany(); });
  afterAll(async () => { await app.close(); });
  function http() { return request(app.getHttpServer()); }
  async function login(sub: string, role: string): Promise<{ token: string; id: string }> {
    fake.register(`tok-${sub}`, { provider: 'google', subject: sub, email: `${sub}@x.com`, name: sub });
    const res = await http().post('/auth/google').send({ idToken: `tok-${sub}`, role });
    return { token: res.body.accessToken, id: res.body.user.id };
  }
  async function adminToken(): Promise<string> {
    fake.register('tok-a', { provider: 'google', subject: 'a1', email: 'a@x.com', name: 'A' });
    await http().post('/auth/google').send({ idToken: 'tok-a', role: 'CLIENT' });
    const u = await prisma.user.findFirst({ where: { providerSubject: 'a1' } });
    await prisma.user.update({ where: { id: u!.id }, data: { role: 'ADMIN' } });
    return (await http().post('/auth/google').send({ idToken: 'tok-a' })).body.accessToken;
  }

  it('cliente denuncia acompanhante → OPEN', async () => {
    const c = await login('c1', 'CLIENT');
    const m = await login('m1', 'MODEL');
    const res = await http().post('/reports').set('Authorization', `Bearer ${c.token}`)
      .send({ reportedUserId: m.id, reason: 'EXPLICITO', details: 'passou da linha' }).expect(201);
    expect(res.body.status).toBe('OPEN');
    expect(res.body.reportedUserId).toBe(m.id);
  });

  it('auto-denúncia → 400', async () => {
    const c = await login('c2', 'CLIENT');
    await http().post('/reports').set('Authorization', `Bearer ${c.token}`)
      .send({ reportedUserId: c.id, reason: 'OUTRO' }).expect(400);
  });

  it('alvo inexistente → 404', async () => {
    const c = await login('c3', 'CLIENT');
    await http().post('/reports').set('Authorization', `Bearer ${c.token}`)
      .send({ reportedUserId: '00000000-0000-0000-0000-000000000000', reason: 'OUTRO' }).expect(404);
  });

  it('sem token → 401', async () => {
    await http().post('/reports').send({ reportedUserId: 'x', reason: 'OUTRO' }).expect(401);
  });

  it('admin lista abertas e resolve; não-admin → 403', async () => {
    const c = await login('c4', 'CLIENT');
    const m = await login('m4', 'MODEL');
    await http().post('/reports').set('Authorization', `Bearer ${c.token}`).send({ reportedUserId: m.id, reason: 'ASSEDIO' }).expect(201);
    const token = await adminToken();

    await http().get('/admin/reports').set('Authorization', `Bearer ${c.token}`).expect(403);

    const list = await http().get('/admin/reports').set('Authorization', `Bearer ${token}`).expect(200);
    expect(list.body).toHaveLength(1);
    const id = list.body[0].id;
    expect(list.body[0].reportedName).toBeDefined();

    await http().post(`/admin/reports/${id}/resolve`).set('Authorization', `Bearer ${token}`).send({ status: 'DISMISSED' }).expect(201);
    const after = await http().get('/admin/reports').set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run → FAIL**

Run: `npx jest --config ./jest-integration.json --runInBand test/reports.e2e-spec.ts`
Expected: FAIL (rotas não existem → 404/401 fora do esperado).

- [ ] **Step 5: Implement `reports.service.ts`**

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Report } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const REASONS = ['EXPLICITO', 'ENCONTRO_FORA', 'ASSEDIO', 'MENOR', 'GOLPE', 'OUTRO'];
const RESOLUTIONS = ['REVIEWED', 'DISMISSED'];

interface CreateReportDto { reportedUserId: string; callId?: string; reason: string; details?: string; }
export interface AdminReportView {
  id: string; reportedUserId: string; reportedName: string; reason: string;
  details: string | null; status: string; createdAt: Date;
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(reporterId: string, dto: CreateReportDto): Promise<Report> {
    if (!dto.reportedUserId || dto.reportedUserId === reporterId) {
      throw new BadRequestException('invalid target');
    }
    if (!REASONS.includes(dto.reason)) {
      throw new BadRequestException('invalid reason');
    }
    const target = await this.prisma.user.findUnique({ where: { id: dto.reportedUserId } });
    if (!target) throw new NotFoundException('target not found');
    return this.prisma.report.create({
      data: {
        reporterUserId: reporterId,
        reportedUserId: dto.reportedUserId,
        callId: dto.callId,
        reason: dto.reason,
        details: dto.details,
      },
    });
  }

  async listOpen(status = 'OPEN'): Promise<AdminReportView[]> {
    const rows = await this.prisma.report.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const ids = [...new Set(rows.map((r) => r.reportedUserId))];
    const profiles = await this.prisma.modelProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, stageName: true } });
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } });
    const nameOf = new Map(profiles.map((p) => [p.userId, p.stageName]));
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({
      id: r.id,
      reportedUserId: r.reportedUserId,
      reportedName: nameOf.get(r.reportedUserId) ?? emailOf.get(r.reportedUserId) ?? r.reportedUserId,
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async resolve(id: string, status: string): Promise<Report> {
    if (!RESOLUTIONS.includes(status)) throw new BadRequestException('invalid status');
    const existing = await this.prisma.report.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('report not found');
    return this.prisma.report.update({ where: { id }, data: { status, resolvedAt: new Date() } });
  }
}
```

- [ ] **Step 6: Implement `reports.controller.ts`**

```ts
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';

interface CreateReportBody { reportedUserId: string; callId?: string; reason: string; details?: string; }

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  async create(@Req() req: Request & { user: AuthUser }, @Body() body: CreateReportBody): Promise<unknown> {
    return this.reports.create(req.user.id, body);
  }
}
```

- [ ] **Step 7: Implement `admin-reports.controller.ts`**

```ts
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ReportsService } from './reports.service';

@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  async list(@Query('status') status?: string): Promise<unknown> {
    return this.reports.listOpen(status ?? 'OPEN');
  }

  @Post(':id/resolve')
  async resolve(@Param('id') id: string, @Body() body: { status: string }): Promise<unknown> {
    return this.reports.resolve(id, body.status);
  }
}
```

- [ ] **Step 8: Implement `reports.module.ts` + register**

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AdminReportsController } from './admin-reports.controller';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule],
  controllers: [ReportsController, AdminReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
```
Adicionar `ReportsModule` ao `imports` do `AppModule`. (Confira em `admin.module.ts` se `JwtAuthGuard`/`RolesGuard` exigem `AuthModule`/`UsersModule` — replique.)

- [ ] **Step 9: Run → PASS + typecheck**

Run: `npx jest --config ./jest-integration.json --runInBand test/reports.e2e-spec.ts` e `npx tsc --noEmit`
Expected: PASS (5/5) / sem erros.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260630000000_reports src/reports src/app.module.ts test/reports.e2e-spec.ts
git commit -m "feat(reports): denuncias + endpoints admin de moderacao"
```

---

### Task 2: Frontend — botão Denunciar no perfil

**Files:**
- Modify: `web/src/types/api.ts` (+ `ReportReason`)
- Create: `web/src/reports/useReport.ts`, `web/src/reports/ReportButton.tsx`
- Modify: `web/src/profile/ModelProfilePage.tsx` (+ `<ReportButton/>`)
- Test: `web/src/reports/report.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`; `useMutation`; tokens; `setSession` (testes).
- Produces: `useReport()`; `<ReportButton reportedUserId={string} />`.

- [ ] **Step 1: Add type**

```ts
export type ReportReason = 'EXPLICITO' | 'ENCONTRO_FORA' | 'ASSEDIO' | 'MENOR' | 'GOLPE' | 'OUTRO';
```

- [ ] **Step 2: Write the failing test**

Boilerplate igual ao `web/src/gifts/gifts.test.tsx`.
```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReportButton } from './ReportButton';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const sess: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'CLIENT', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}
beforeEach(() => { localStorage.clear(); setSession(sess); });
afterEach(() => vi.restoreAllMocks());

describe('ReportButton', () => {
  it('denuncia com motivo e mostra sucesso', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/reports') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', status: 'OPEN' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<ReportButton reportedUserId="m1" />));
    await userEvent.click(screen.getByRole('button', { name: /denunciar/i }));
    await userEvent.click(screen.getByRole('button', { name: /conteúdo explícito/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/reports') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ reportedUserId: 'm1', reason: 'EXPLICITO' });
    });
    await waitFor(() => expect(screen.getByText(/denúncia enviada/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 3: Run → FAIL**

Run: `cd web && npx vitest run src/reports/report.test.tsx`

- [ ] **Step 4: Implement `useReport.ts`**

```ts
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { ReportReason } from '../types/api';

export function useReport(): ReturnType<typeof useMutation<unknown, Error, { reportedUserId: string; reason: ReportReason; details?: string }>> {
  return useMutation<unknown, Error, { reportedUserId: string; reason: ReportReason; details?: string }>({
    mutationFn: (body) => apiFetch('/reports', { method: 'POST', body, auth: true }),
  });
}
```

- [ ] **Step 5: Implement `ReportButton.tsx`**

```tsx
import { useState } from 'react';
import { useReport } from './useReport';
import type { ReportReason } from '../types/api';

const OPTIONS: { reason: ReportReason; label: string }[] = [
  { reason: 'EXPLICITO', label: 'Conteúdo explícito' },
  { reason: 'ENCONTRO_FORA', label: 'Encontro/pagamento fora da plataforma' },
  { reason: 'ASSEDIO', label: 'Assédio ou abuso' },
  { reason: 'MENOR', label: 'Suspeita de menor de idade' },
  { reason: 'GOLPE', label: 'Golpe' },
  { reason: 'OUTRO', label: 'Outro' },
];

export function ReportButton({ reportedUserId }: { reportedUserId: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const report = useReport();

  if (report.isSuccess) return <p className="mt-8 text-mist text-xs">Denúncia enviada. Obrigado por ajudar a manter a Samy segura.</p>;

  return (
    <div className="mt-8">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="text-mist text-xs hover:text-ember">Denunciar</button>
      ) : (
        <div className="rounded-xl bg-velvet p-4">
          <p className="text-mist text-sm">Motivo da denúncia</p>
          <div className="mt-2 flex flex-col gap-1">
            {OPTIONS.map((o) => (
              <button key={o.reason} type="button" disabled={report.isPending}
                onClick={() => report.mutate({ reportedUserId, reason: o.reason })}
                className="text-left text-sm text-cream hover:text-ember disabled:opacity-50">
                {o.label}
              </button>
            ))}
          </div>
          {report.isError && <p className="mt-2 text-ember text-xs">Não foi possível enviar. Tente de novo.</p>}
          <button type="button" onClick={() => setOpen(false)} className="mt-2 text-mist text-xs hover:text-cream">cancelar</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Render in `ModelProfilePage.tsx`**

Importar e renderizar após `<GiftPicker .../>`:
```tsx
import { ReportButton } from '../reports/ReportButton';
// ...
      <GiftPicker modelId={model.userId} />
      <ReportButton reportedUserId={model.userId} />
```

- [ ] **Step 7: Run → PASS + build**

Run: `cd web && npx vitest run src/reports/report.test.tsx && npm run build`
Expected: PASS; build limpo.

- [ ] **Step 8: Commit**

```bash
git add web/src/types/api.ts web/src/reports web/src/profile/ModelProfilePage.tsx
git commit -m "feat(web): botao Denunciar no perfil"
```

---

### Task 3: Frontend — seção de denúncias no admin

**Files:**
- Modify: `web/src/types/api.ts` (+ `AdminReport`)
- Create: `web/src/admin/useAdminReports.ts`
- Modify: `web/src/admin/AdminPage.tsx` (+ seção Denúncias)
- Test: `web/src/admin/admin-reports.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`; `useQuery`/`useMutation`/`useQueryClient`; `useAuth`; `TierBadge`? não. `useSetUserStatus` (já existe) pro atalho suspender.
- Produces: `AdminReport`; `useAdminReports()` (query + resolve).

- [ ] **Step 1: Add type**

```ts
export interface AdminReport {
  id: string;
  reportedUserId: string;
  reportedName: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
}
```

- [ ] **Step 2: Write the failing test**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AdminPage } from './AdminPage';
import { setSession } from '../lib/session';
import type { Session } from '../lib/session';

const admin: Session = { accessToken: 'a', refreshToken: 'r', user: { id: 'u1', role: 'ADMIN', status: 'ACTIVE', email: 'a@b.c', displayName: 'A' } };
function json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
function wrap(ui: React.ReactNode): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>;
}
const reports = [{ id: 'r1', reportedUserId: 'm1', reportedName: 'Lara', reason: 'EXPLICITO', details: 'x', status: 'OPEN', createdAt: '2026-06-30T00:00:00.000Z' }];
beforeEach(() => { localStorage.clear(); setSession(admin); });
afterEach(() => vi.restoreAllMocks());

describe('AdminPage denúncias', () => {
  it('lista denúncias e "Revisado" chama resolve', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/admin/users')) return Promise.resolve(json(200, []));
      if (u.endsWith('/admin/reports')) return Promise.resolve(json(200, reports));
      if (u.includes('/admin/reports/r1/resolve') && init?.method === 'POST') return Promise.resolve(json(201, { id: 'r1', status: 'REVIEWED' }));
      return Promise.resolve(json(200, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(wrap(<AdminPage />));
    await waitFor(() => expect(screen.getByText('Lara')).toBeInTheDocument());
    expect(screen.getByText(/explícito/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /revisado/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => String(c[0]).includes('/admin/reports/r1/resolve') && (c[1] as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
    });
  });
});
```

- [ ] **Step 3: Run → FAIL**

Run: `cd web && npx vitest run src/admin/admin-reports.test.tsx`

- [ ] **Step 4: Implement `useAdminReports.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api-client';
import type { AdminReport } from '../types/api';

export function useAdminReports(): ReturnType<typeof useQuery<AdminReport[]>> {
  return useQuery<AdminReport[]>({
    queryKey: ['admin-reports'],
    queryFn: () => apiFetch<AdminReport[]>('/admin/reports', { auth: true }),
  });
}

export function useResolveReport(): ReturnType<typeof useMutation<unknown, Error, { id: string; status: 'REVIEWED' | 'DISMISSED' }>> {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string; status: 'REVIEWED' | 'DISMISSED' }>({
    mutationFn: ({ id, status }) => apiFetch(`/admin/reports/${id}/resolve`, { method: 'POST', body: { status }, auth: true }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-reports'] }); },
  });
}
```

- [ ] **Step 5: Add the section to `AdminPage.tsx`**

Importar os hooks e o `useSetUserStatus` (já existe). Adicionar, após a lista de usuários (antes de fechar o `<main>`), uma seção:
```tsx
import { useAdminReports, useResolveReport } from './useAdminReports';
// dentro do componente:
  const { data: reports } = useAdminReports();
  const resolve = useResolveReport();
  const setStatus = useSetUserStatus();
// no JSX, após a <ul> de usuários:
      <h2 className="mt-12 font-display text-2xl text-cream">Denúncias</h2>
      {reports && reports.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2">
          {reports.map((r) => (
            <li key={r.id} className="rounded-xl bg-velvet px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-cream">{r.reportedName}</span>
                <span className="font-mono text-xs text-ember">{r.reason}</span>
              </div>
              {r.details && <p className="mt-1 text-mist text-sm">{r.details}</p>}
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => resolve.mutate({ id: r.id, status: 'REVIEWED' })} className="rounded-full border border-mist/40 px-3 py-1 text-xs text-cream hover:border-ember">Revisado</button>
                <button type="button" onClick={() => resolve.mutate({ id: r.id, status: 'DISMISSED' })} className="rounded-full border border-mist/40 px-3 py-1 text-xs text-mist hover:border-cream">Descartar</button>
                <button type="button" onClick={() => setStatus.mutate({ id: r.reportedUserId, action: 'suspend' })} className="rounded-full border border-ember/60 px-3 py-1 text-xs text-ember hover:border-ember">Suspender conta</button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-mist">Nenhuma denúncia aberta.</p>
      )}
```
> Garanta que o `useSetUserStatus` já importado no AdminPage (Task B5) seja reaproveitado; não duplique.

- [ ] **Step 6: Run → PASS + whole suite + build**

Run: `cd web && npx vitest run && npm run build`
Expected: tudo verde; build limpo.

- [ ] **Step 7: Commit**

```bash
git add web/src/types/api.ts web/src/admin/useAdminReports.ts web/src/admin/AdminPage.tsx web/src/admin/admin-reports.test.tsx
git commit -m "feat(web): secao de denuncias no painel admin"
```

---

## Notas de verificação final
- `npx tsc --noEmit` limpo; e2e de reports verde; migração `reports` aplicada no banco de teste.
- Front `npm run build` limpo; suite verde.
- Fluxo ponta-a-ponta: denunciar no perfil → aparece no admin → resolver/suspender.
