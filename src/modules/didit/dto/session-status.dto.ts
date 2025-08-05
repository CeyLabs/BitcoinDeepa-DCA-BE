export interface SessionStatusDto {
  session_id: string;
  status:
    | 'Not Started'
    | 'In Progress'
    | 'Approved'
    | 'Declined'
    | 'Kyc Expired'
    | 'In Review'
    | 'Expired'
    | 'Abandoned';
  verification_results?: {
    id_verification?: {
      status: 'passed' | 'failed';
      document_type?: string;
      country?: string;
      confidence_score?: number;
    };
    liveness_detection?: {
      status: 'passed' | 'failed';
      confidence_score?: number;
    };
    face_match?: {
      status: 'passed' | 'failed';
      confidence_score?: number;
    };
    aml_screening?: {
      status: 'passed' | 'failed';
      risk_level?: string;
    };
  };
  created_at: string;
  expires_at: string;
  completed_at?: string;
}
