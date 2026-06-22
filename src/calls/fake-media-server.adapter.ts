import { Injectable } from '@nestjs/common';
import type { MediaServerProvider, MediaToken } from './media-server.port';

@Injectable()
export class FakeMediaServer implements MediaServerProvider {
  async issueToken(roomName: string, identity: string): Promise<MediaToken> {
    return { token: `tok:${roomName}:${identity}`, url: 'wss://fake.media/room' };
  }
}
