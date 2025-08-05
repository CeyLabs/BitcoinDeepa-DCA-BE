import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateSessionDto,
  CreateSessionResponse,
} from './dto/create-session.dto';
import { SessionStatusDto } from './dto/session-status.dto';

@Injectable()
export class DiditService {
  private readonly logger = new Logger(DiditService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('DIDIT_API_KEY') || '';
    this.baseUrl =
      this.configService.get<string>('DIDIT_BASE_URL') ||
      'https://api.didit.me';

    if (!this.apiKey) {
      this.logger.warn(
        'DIDIT_API_KEY not configured - KYC functionality will be disabled',
      );
    }
  }

  async createVerificationSession(
    userId: string,
    options?: Partial<CreateSessionDto>,
  ): Promise<CreateSessionResponse> {
    if (!this.apiKey) {
      throw new HttpException(
        'Didit API not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const defaultOptions: CreateSessionDto = {
      verification_types: ['id_verification', 'liveness_detection'],
      webhook_url: `${this.configService.get<string>('BASE_URL')}/didit/webhook`,
      language: 'en',
      expiry_time: 24 * 60 * 60, // 24 hours
      reference_id: userId,
      ...options,
    };

    try {
      const response = await fetch(`${this.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(defaultOptions),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Failed to create Didit session: ${response.status} ${errorText}`,
        );
        throw new HttpException(
          `Failed to create verification session: ${response.statusText}`,
          response.status,
        );
      }

      const result = await response.json();
      this.logger.log(
        `Created Didit session ${result.session_id} for user ${userId}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Error creating Didit session for user ${userId}:`,
        error,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to create verification session',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatusDto> {
    if (!this.apiKey) {
      throw new HttpException(
        'Didit API not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Failed to get Didit session status: ${response.status} ${errorText}`,
        );
        throw new HttpException(
          `Failed to get session status: ${response.statusText}`,
          response.status,
        );
      }

      const result = await response.json();
      return result;
    } catch (error) {
      this.logger.error(
        `Error getting Didit session status for ${sessionId}:`,
        error,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to get session status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.apiKey) {
      throw new HttpException(
        'Didit API not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Failed to delete Didit session: ${response.status} ${errorText}`,
        );
        throw new HttpException(
          `Failed to delete session: ${response.statusText}`,
          response.status,
        );
      }

      this.logger.log(`Deleted Didit session ${sessionId}`);
    } catch (error) {
      this.logger.error(`Error deleting Didit session ${sessionId}:`, error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to delete session',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  isVerificationSuccessful(sessionStatus: SessionStatusDto): boolean {
    if (sessionStatus.status !== 'Approved') {
      return false;
    }

    const results = sessionStatus.verification_results;
    if (!results) {
      return false;
    }

    // Check if all required verifications passed
    const idVerificationPassed = results.id_verification?.status === 'passed';
    const livenessPassed = results.liveness_detection?.status === 'passed';

    return idVerificationPassed && livenessPassed;
  }

  getFailureReason(sessionStatus: SessionStatusDto): string | null {
    if (sessionStatus.status === 'Declined') {
      return 'Verification declined';
    }

    if (sessionStatus.status === 'Expired') {
      return 'Verification session expired';
    }

    if (sessionStatus.status === 'Abandoned') {
      return 'Verification was abandoned';
    }

    const results = sessionStatus.verification_results;
    if (!results) {
      return null;
    }

    const failures: string[] = [];

    if (results.id_verification?.status === 'failed') {
      failures.push('ID verification failed');
    }

    if (results.liveness_detection?.status === 'failed') {
      failures.push('Liveness detection failed');
    }

    if (results.face_match?.status === 'failed') {
      failures.push('Face match failed');
    }

    if (results.aml_screening?.status === 'failed') {
      failures.push('AML screening failed');
    }

    return failures.length > 0 ? failures.join(', ') : null;
  }
}
