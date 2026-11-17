import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateSessionResponse } from './dto/create-session.dto';
import { DiditStatusType } from '../user/enums/kyc-status.enum';

export interface DiditSession {
  status: DiditStatusType | null;
  url: string | null;
}

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
    };

    try {
      const response = await fetch(`${this.baseUrl}/v3/session/`, {
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

  /** Current status and resume URL of a session, or null if Didit doesn't know it. */
  async getSession(sessionId: string): Promise<DiditSession | null> {
    if (!this.apiKey) {
      throw new HttpException(
        'Didit API not configured',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/v3/session/${sessionId}/decision/`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-api-key': this.apiKey,
          },
        },
      );

      if (response.status === 404) {
        this.logger.warn(`Didit session ${sessionId} not found`);
        return null;
      }
      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `Failed to get Didit session ${sessionId}: ${response.status} ${errorText}`,
        );
        throw new HttpException(
          `Failed to get session: ${response.statusText}`,
          response.status,
        );
      }

      const result = await response.json();
      return {
        status: result.status ?? null,
        url: result.session_url ?? result.url ?? null,
      };
    } catch (error) {
      this.logger.error(`Error getting Didit session ${sessionId}:`, error);
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        'Failed to get session',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
