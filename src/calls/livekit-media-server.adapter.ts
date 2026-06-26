import { Injectable } from '@nestjs/common';
import { AccessToken } from 'livekit-server-sdk';
import type { MediaServerProvider, MediaToken } from './media-server.port';

@Injectable()
export class LivekitMediaServer implements MediaServerProvider {
  async issueToken(roomName: string, identity: string): Promise<MediaToken> {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !url) {
      throw new Error('LiveKit not configured');
    }
    const at = new AccessToken(apiKey, apiSecret, { identity });
    at.addGrant({ roomJoin: true, room: roomName });
    const token = await at.toJwt();
    return { token, url };
  }
}
