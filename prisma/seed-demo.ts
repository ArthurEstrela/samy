import { PrismaClient, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { config } from 'dotenv';

config();

interface DemoModel {
  sub: string;
  stageName: string;
  price: string;
  tags: string[];
  bio: string;
  presence: 'ONLINE' | 'OCUPADA' | 'OFFLINE';
}

const MODELS: DemoModel[] = [
  { sub: 'm-lara', stageName: 'Lara', price: '4.00', tags: ['suave', 'grave'], bio: 'Voz de veludo pra noites longas.', presence: 'ONLINE' },
  { sub: 'm-bianca', stageName: 'Bianca', price: '6.00', tags: ['doce', 'sussurro'], bio: 'Sussurros que acalmam.', presence: 'ONLINE' },
  { sub: 'm-helena', stageName: 'Helena', price: '5.00', tags: ['firme', 'dominadora'], bio: 'No comando, sempre.', presence: 'ONLINE' },
  { sub: 'm-yara', stageName: 'Yara', price: '3.50', tags: ['carinhosa', 'calma'], bio: 'Conversa boa e colo.', presence: 'ONLINE' },
  { sub: 'm-sofia', stageName: 'Sofia', price: '8.00', tags: ['intensa', 'rouca'], bio: 'Intensidade do começo ao fim.', presence: 'OCUPADA' },
  { sub: 'm-nina', stageName: 'Nina', price: '4.50', tags: ['timida', 'fofa'], bio: 'Doçura tímida.', presence: 'OFFLINE' },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const client = await prisma.user.upsert({
      where: { provider_providerSubject: { provider: 'dev', providerSubject: 'dev-client' } },
      update: { status: 'ACTIVE' },
      create: { role: 'CLIENT', provider: 'dev', providerSubject: 'dev-client', email: 'dev@samy.local', displayName: 'Cliente Dev', status: 'ACTIVE' },
    });

    const ids: Record<string, string> = {};
    for (const m of MODELS) {
      const user = await prisma.user.upsert({
        where: { provider_providerSubject: { provider: 'dev', providerSubject: m.sub } },
        update: { status: 'ACTIVE' },
        create: { role: 'MODEL', provider: 'dev', providerSubject: m.sub, email: `${m.sub}@samy.local`, displayName: `Real ${m.stageName}`, status: 'ACTIVE' },
      });
      ids[m.sub] = user.id;
      await prisma.modelProfile.upsert({
        where: { userId: user.id },
        update: { stageName: m.stageName, pricePerMinute: new Prisma.Decimal(m.price), tags: m.tags, bio: m.bio },
        create: { userId: user.id, stageName: m.stageName, pricePerMinute: new Prisma.Decimal(m.price), tags: m.tags, bio: m.bio },
      });
    }

    // OCUPADA: uma chamada ACTIVE persistida (não depende de presença/TTL)
    const sofiaId = ids['m-sofia'];
    await prisma.call.deleteMany({ where: { modelUserId: sofiaId, status: 'ACTIVE' } });
    await prisma.call.create({
      data: { clientUserId: client.id, modelUserId: sofiaId, status: 'ACTIVE', pricePerMinuteSnapshot: new Prisma.Decimal('8.00'), startedAt: new Date(), roomName: `demo:${sofiaId}` },
    });

    // Presença ONLINE via Redis (TTL 30s — re-rode o seed pra reacender)
    const url = process.env.REDIS_URL;
    if (url) {
      const redis = new Redis(url);
      try {
        for (const m of MODELS) {
          if (m.presence === 'ONLINE') {
            await redis.set(`presence:model:${ids[m.sub]}`, 'ONLINE', 'EX', 30);
          }
        }
      } finally {
        await redis.quit();
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn('REDIS_URL ausente — modelos ONLINE ficarão OFFLINE (sem presença).');
    }

    // eslint-disable-next-line no-console
    console.log(`seed-demo ok: cliente dev + ${MODELS.length} modelos (4 ONLINE/TTL 30s, 1 OCUPADA, 1 OFFLINE).`);
  } finally {
    await prisma.$disconnect();
  }
}

void main();
