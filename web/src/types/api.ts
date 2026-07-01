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

export interface MediaToken { token: string; url: string; }

export interface Call {
  id: string;
  clientUserId: string;
  modelUserId: string;
  status: 'REQUESTED' | 'ACTIVE' | 'ENDED';
  endReason: string | null;
  pricePerMinuteSnapshot: string;
  roomName: string | null;
  startedAt: string | null;
}

export interface CallView { call: Call; media?: MediaToken; }

export interface GiftType { id: string; name: string; priceCredits: string; active: boolean; }

export type Tier = 'BRONZE' | 'PRATA' | 'OURO' | 'DIAMANTE';

export interface MyRanking {
  tier: Tier;
  earned: string;
  takeRate: string;
  nextTier: Tier | null;
  nextThreshold: string | null;
  remaining: string | null;
}

export interface RankingEntry {
  rank: number;
  modelId: string;
  stageName: string;
  tier: Tier;
}

export interface RechargeSummary {
  id: string;
  amount: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
}

export interface AdminUser {
  id: string;
  role: string;
  status: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export type ReportReason = 'EXPLICITO' | 'ENCONTRO_FORA' | 'ASSEDIO' | 'MENOR' | 'GOLPE' | 'OUTRO';

export interface AdminReport {
  id: string;
  reportedUserId: string;
  reportedName: string;
  reason: string;
  details: string | null;
  status: string;
  createdAt: string;
}
