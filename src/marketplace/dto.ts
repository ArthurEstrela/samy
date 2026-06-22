export interface UpsertProfileDto {
  bio?: string;
  pricePerMinute: string;
  tags?: string[];
  voicePreviewUrl?: string;
}
