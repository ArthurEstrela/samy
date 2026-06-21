import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const [provider, subject, email, name] = process.argv.slice(2);
  if (!provider || !subject || !email || !name) {
    throw new Error('usage: seed:admin -- <provider> <subject> <email> <name>');
  }
  const prisma = new PrismaClient();
  await prisma.user.upsert({
    where: { provider_providerSubject: { provider, providerSubject: subject } },
    update: { role: 'ADMIN', status: 'ACTIVE' },
    create: { role: 'ADMIN', provider, providerSubject: subject, email, displayName: name, status: 'ACTIVE' },
  });
  await prisma.$disconnect();
  // eslint-disable-next-line no-console
  console.log(`admin garantido: ${provider}:${subject}`);
}

void main();
