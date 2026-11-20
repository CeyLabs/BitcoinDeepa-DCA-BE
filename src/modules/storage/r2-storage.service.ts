import { Injectable, Logger } from '@nestjs/common';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Presigned URLs (upload and view) are short-lived. */
export const PRESIGN_TTL_SECONDS = 5 * 60;

export interface StoredObject {
  size: number;
  contentType: string | undefined;
}

/**
 * Cloudflare R2 (S3 API) for private files. Clients never get credentials:
 * they upload with a presigned PUT and admins view with a presigned GET.
 */
@Injectable()
export class R2StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly bucket = process.env.R2_BUCKET || '';
  private client: S3Client | null = null;

  isConfigured(): boolean {
    return !!(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      this.bucket
    );
  }

  private s3(): S3Client {
    if (!this.isConfigured()) {
      throw new Error('R2 storage is not configured');
    }
    // R2_ENDPOINT points at another S3-compatible server (e.g. MinIO locally)
    const endpoint = process.env.R2_ENDPOINT;
    this.client ??= new S3Client({
      region: 'auto',
      endpoint:
        endpoint ||
        `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: !!endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
    return this.client;
  }

  /** The upload must use exactly this Content-Type and Content-Length. */
  presignUpload(
    key: string,
    contentType: string,
    size: number,
  ): Promise<string> {
    return getSignedUrl(
      this.s3(),
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
      }),
      {
        expiresIn: PRESIGN_TTL_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  presignDownload(key: string): Promise<string> {
    return getSignedUrl(
      this.s3(),
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );
  }

  /** null when the object doesn't exist. */
  async head(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.s3().send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: Number(res.ContentLength ?? 0),
        contentType: res.ContentType,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      this.logger.error(`R2 head ${key} failed: ${(error as Error).message}`);
      throw error;
    }
  }
}
