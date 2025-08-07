export interface CreateSessionDto {
  verification_types: string[];
  callback_url?: string;
  webhook_url?: string;
  language?: string;
  expiry_time?: number;
  reference_id?: string;
}

export interface CreateSessionResponse {
  session_id: string;
  verification_url: string;
  expires_at: string;
  status: string;
}
