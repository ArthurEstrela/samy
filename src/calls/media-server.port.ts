export const MEDIA_SERVER = 'MEDIA_SERVER';

export interface MediaToken {
  token: string;
  url: string;
}

export interface MediaServerProvider {
  issueToken(roomName: string, identity: string): Promise<MediaToken>;
}
