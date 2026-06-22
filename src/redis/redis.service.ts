import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

type Presence = 'ONLINE' | 'OFFLINE';
const TTL_SECONDS = 30;
const key = (modelId: string): string => `presence:model:${modelId}`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL env var is required');
    }
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async setOnline(modelId: string): Promise<void> {
    await this.client.set(key(modelId), 'ONLINE', 'EX', TTL_SECONDS);
  }

  async getStatus(modelId: string): Promise<Presence> {
    const v = await this.client.get(key(modelId));
    return v === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
  }

  async getStatuses(modelIds: string[]): Promise<Record<string, Presence>> {
    const out: Record<string, Presence> = {};
    if (modelIds.length === 0) {
      return out;
    }
    const values = await this.client.mget(...modelIds.map(key));
    modelIds.forEach((id, i) => {
      out[id] = values[i] === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
    });
    return out;
  }

  presenceTtlSeconds(): number {
    return TTL_SECONDS;
  }

  async ttlOf(modelId: string): Promise<number> {
    return this.client.ttl(key(modelId));
  }
}
