import { Injectable } from '@nestjs/common';
import type { MediaServerProvider, MediaToken } from './media-server.port';

@Injectable()
export class LivekitMediaServer implements MediaServerProvider {
  async issueToken(_roomName: string, _identity: string): Promise<MediaToken> {
    throw new Error('media server not configured');
  }
}
