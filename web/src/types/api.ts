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

export interface Recharge {
  id: string;
  amount: string;
  status: 'PENDING' | 'PAID' | 'FAILED';
  qrText: string | null;
  expiresAt: string | null;
  paidAt?: string | null;
}

export interface ModelProfile {
  userId: string;
  stageName: string;
  bio: string | null;
  pricePerMinute: string;
  tags: string[];
  voicePreviewUrl: string | null;
}

export interface UpsertProfileInput {
  stageName: string;
  bio?: string;
  pricePerMinute: string;
  tags?: string[];
  voicePreviewUrl?: string;
}

export interface Payout {
  id: string;
  amount: string;
  status: string;
  pixKey: string;
  createdAt: string;
  processedAt?: string | null;
}

export interface KycStatusView {
  status: 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
  reason?: string;
  createdAt?: string;
  resolvedAt?: string;
}
