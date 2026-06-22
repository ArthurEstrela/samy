export interface UpsertProfileDto {
  stageName: string;
  bio?: string;
  pricePerMinute: string;
  tags?: string[];
  voicePreviewUrl?: string;
}
