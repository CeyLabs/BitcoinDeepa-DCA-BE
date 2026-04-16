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
  private readonly workflowId: string;
  private readonly redirectUrl: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('DIDIT_API_KEY') || '';
    this.redirectUrl =
      this.configService.get<string>('DIDIT_REDIRECT_URL') || '';
    this.baseUrl =
      this.configService.get<string>('DIDIT_BASE_URL') ||
      'https://verification.didit.me';

    this.workflowId = this.configService.get<string>('DIDIT_WORKFLOW_ID') || '';

    if (!this.apiKey || !this.workflowId) {
      this.logger.warn(
        'DIDIT_API_KEY or DIDIT_WORKFLOW_ID not configured - KYC functionality will be disabled',
      );
    }
  }

  async createVerificationSession(
    userId: string,
    options?: Partial<CreateSessionDto>,
  ): Promise<CreateSessionResponse> {
    if (!this.apiKey || !this.workflowId) {
      throw new HttpException(
        'Didit API not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const payload = {
      workflow_id: this.workflowId,
      vendor_data: userId,
      callback: this.redirectUrl,
      ...options,
    };

    try {
      const response = await fetch(`${this.baseUrl}/v2/session/`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
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
      const response = await fetch(
        `${this.baseUrl}/v2/session/${sessionId}/decision/`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-api-key': this.apiKey,
          },
        },
      );

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

  async getSessionDetails(sessionId: string): Promise<{ url: string } | null> {
    if (!this.apiKey) {
      throw new HttpException(
        'Didit API not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/v2/session/${sessionId}/decision/`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-api-key': this.apiKey,
          },
        },
      );

      if (!response.ok) {
        if (response.status === 404) {
          this.logger.warn(`Didit session ${sessionId} not found`);
          return null;
        }
        const errorText = await response.text();
        this.logger.error(
          `Failed to get Didit session details: ${response.status} ${errorText}`,
        );
        throw new HttpException(
          `Failed to get session details: ${response.statusText}`,
          response.status,
        );
      }

      const result = await response.json();
      return {
        url: result.session_url || null,
      };
    } catch (error) {
      this.logger.error(
        `Error getting Didit session details for ${sessionId}:`,
        error,
      );
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to get session details',
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
          'x-api-key': this.apiKey,
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
