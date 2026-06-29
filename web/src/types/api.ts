export type CallStatus = 'ONLINE' | 'OCUPADA' | 'OFFLINE';

export interface ModelCard {
  userId: string;
  stageName: string;
  bio: string | null;
  pricePerMinute: string;
  tags: string[];
  voicePreviewUrl: string | null;
  status: CallStatus;
  isFavorite: boolean;
}

export interface SessionUser {
  id: string;
  role: string;
  status: string;
  email: string;
  displayName: string;
}

export interface AuthResult { accessToken: string; refreshToken: string; user: SessionUser; }
export interface RefreshResult { accessToken: string; refreshToken: string; }
