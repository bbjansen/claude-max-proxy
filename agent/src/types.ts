export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface CredentialStore {
  read(): Promise<OAuthCredential | null>;
  write(cred: OAuthCredential): Promise<void>;
}

export interface RefreshClient {
  refresh(refreshToken: string): Promise<OAuthCredential>;
}

export type AcquireLock = () => Promise<() => Promise<void>>;

export type AccountId = string;
export type ModelTier = "opus" | "sonnet" | "haiku" | "other";
