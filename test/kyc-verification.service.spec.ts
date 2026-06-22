import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { KycVerificationService } from '../src/kyc-verification/kyc-verification.service';
import { KYC_VERIFICATION_PROVIDER } from '../src/kyc-verification/kyc-verification.port';
import { FakeKycVerificationProvider } from '../src/kyc-verification/fake-kyc-verification.adapter';

describe('KycVerificationService', () => {
  let service: KycVerificationService;
  let prisma: PrismaService;
  let fake: FakeKycVerificationProvider;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        KycVerificationService,
        { provide: KYC_VERIFICATION_PROVIDER, useClass: FakeKycVerificationProvider },
      ],
    }).compile();
    service = mod.get(KycVerificationService);
    prisma = mod.get(PrismaService);
    fake = mod.get(KYC_VERIFICATION_PROVIDER);
  });
  beforeEach(async () => {
    fake.reset();
    await prisma.kycVerification.deleteMany();
    await prisma.kycStatus.deleteMany();
    await prisma.refreshToken.deleteMany();
    await prisma.user.deleteMany();
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function makeModel(id: string, status = 'PENDING_VERIFICATION'): Promise<void> {
    await prisma.user.create({
      data: { id, role: 'MODEL', provider: 'google', providerSubject: id, email: `${id}@x.com`, displayName: id, status },
    });
  }

  it('start cria PENDING e retorna clientToken', async () => {
    await makeModel('m1');
    const r = await service.start('model:m1', 'm1');
    expect(r.status).toBe('PENDING');
    expect(r.clientToken).toBeTruthy();
    expect(fake.calls).toHaveLength(1);
  });

  it('start reusa a sessão PENDING válida (não chama o provedor de novo)', async () => {
    await makeModel('m2');
    const a = await service.start('model:m2', 'm2');
    const b = await service.start('model:m2', 'm2');
    expect(b.clientToken).toBe(a.clientToken);
    expect(fake.calls).toHaveLength(1);
    expect(await prisma.kycVerification.count({ where: { account: 'model:m2' } })).toBe(1);
  });

  it('start cria nova sessão quando a anterior expirou', async () => {
    await makeModel('m3');
    await service.start('model:m3', 'm3');
    await prisma.kycVerification.updateMany({ where: { account: 'model:m3' }, data: { sessionExpiresAt: new Date(Date.now() - 1000) } });
    await service.start('model:m3', 'm3');
    expect(fake.calls).toHaveLength(2);
  });

  it('start lança 409 se já aprovada', async () => {
    await makeModel('m4');
    await prisma.kycStatus.create({ data: { account: 'model:m4', approved: true } });
    await expect(service.start('model:m4', 'm4')).rejects.toBeInstanceOf(ConflictException);
  });

  it('applyResult APPROVED libera: kyc_status true + user ACTIVE', async () => {
    await makeModel('m5');
    const r = await service.start('model:m5', 'm5');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'APPROVED');
    expect((await prisma.kycStatus.findUnique({ where: { account: 'model:m5' } }))?.approved).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: 'm5' } }))?.status).toBe('ACTIVE');
  });

  it('applyResult APPROVED não tira o SUSPENDED do usuário (mas marca kyc_status)', async () => {
    await makeModel('m6', 'SUSPENDED');
    const r = await service.start('model:m6', 'm6');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'APPROVED');
    expect((await prisma.kycStatus.findUnique({ where: { account: 'model:m6' } }))?.approved).toBe(true);
    expect((await prisma.user.findUnique({ where: { id: 'm6' } }))?.status).toBe('SUSPENDED');
  });

  it('applyResult REJECTED grava reason; permite nova verificação', async () => {
    await makeModel('m7');
    const r = await service.start('model:m7', 'm7');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'REJECTED', 'documento ilegível');
    const rejected = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    expect(rejected?.status).toBe('REJECTED');
    expect(rejected?.reason).toBe('documento ilegível');
    const r2 = await service.start('model:m7', 'm7');
    expect(r2.verificationId).not.toBe(r.verificationId);
    expect(fake.calls).toHaveLength(2);
  });

  it('applyResult é idempotente em verificação já resolvida', async () => {
    await makeModel('m8');
    const r = await service.start('model:m8', 'm8');
    const v = await prisma.kycVerification.findUnique({ where: { id: r.verificationId } });
    await service.applyResult(v!.providerRef, 'APPROVED');
    await prisma.user.update({ where: { id: 'm8' }, data: { status: 'SUSPENDED' } });
    await service.applyResult(v!.providerRef, 'APPROVED');
    expect((await prisma.user.findUnique({ where: { id: 'm8' } }))?.status).toBe('SUSPENDED');
  });

  it('applyResult ignora providerRef desconhecido', async () => {
    await expect(service.applyResult('nope', 'APPROVED')).resolves.toBeUndefined();
  });

  it('getLatest devolve NONE quando nunca iniciou', async () => {
    expect((await service.getLatest('model:zzz')).status).toBe('NONE');
  });
});
