import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class PresenceService {
  constructor(private readonly redis: RedisService) {}

  heartbeat(modelId: string): Promise<void> {
    return this.redis.setOnline(modelId);
  }

  getStatus(modelId: string): Promise<'ONLINE' | 'OFFLINE'> {
    return this.redis.getStatus(modelId);
  }

  getStatuses(modelIds: string[]): Promise<Record<string, 'ONLINE' | 'OFFLINE'>> {
    return this.redis.getStatuses(modelIds);
  }
}
