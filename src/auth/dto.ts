export interface GoogleLoginDto {
  idToken: string;
  role?: string;
}

export interface RefreshDto {
  refreshToken: string;
}
