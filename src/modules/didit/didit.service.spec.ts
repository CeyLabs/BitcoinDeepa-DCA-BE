import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiditService } from './didit.service';

function makeService(env: Record<string, string> = {}) {
  return new DiditService(
    new ConfigService({
      DIDIT_API_KEY: 'api-key',
      DIDIT_WORKFLOW_ID: 'wf-1',
      DIDIT_REDIRECT_URL: 'https://app.test/kyc-done',
      DIDIT_BASE_URL: 'https://didit.test',
      ...env,
    }),
  );
}

const status = (e: unknown) => (e as HttpException).getStatus();

describe('DiditService', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  describe('createVerificationSession', () => {
    it('creates a v3 session for the user', async () => {
      fetchSpy.mockResolvedValue(
        Response.json({ session_id: 's1', url: 'https://verify/s1' }),
      );
      await expect(
        makeService().createVerificationSession('100000001'),
      ).resolves.toEqual({ session_id: 's1', url: 'https://verify/s1' });

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://didit.test/v3/session/');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(
        'api-key',
      );
      expect(JSON.parse(init.body as string)).toEqual({
        workflow_id: 'wf-1',
        vendor_data: '100000001',
        callback: 'https://app.test/kyc-done',
      });
    });

    it('is unavailable (503) without API key or workflow', async () => {
      const envs: Record<string, string>[] = [
        { DIDIT_API_KEY: '' },
        { DIDIT_WORKFLOW_ID: '' },
      ];
      for (const env of envs) {
        const err = await makeService(env)
          .createVerificationSession('1')
          .catch((e: unknown) => e);
        expect(status(err)).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('passes through the Didit error status', async () => {
      fetchSpy.mockResolvedValue(
        new Response('bad key', { status: 403, statusText: 'Forbidden' }),
      );
      const err = await makeService()
        .createVerificationSession('1')
        .catch((e: unknown) => e);
      expect(status(err)).toBe(403);
    });

    it('maps network errors to 500', async () => {
      fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
      const err = await makeService()
        .createVerificationSession('1')
        .catch((e: unknown) => e);
      expect(status(err)).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  describe('getSession', () => {
    it('returns status and resume URL', async () => {
      fetchSpy.mockResolvedValue(
        Response.json({ status: 'In Progress', session_url: 'https://v/s1' }),
      );
      await expect(makeService().getSession('s1')).resolves.toEqual({
        status: 'In Progress',
        url: 'https://v/s1',
      });
      expect(fetchSpy.mock.calls[0][0]).toBe(
        'https://didit.test/v3/session/s1/decision/',
      );
    });

    it('falls back to `url` and nulls', async () => {
      fetchSpy.mockResolvedValueOnce(Response.json({ url: 'https://v/s2' }));
      await expect(makeService().getSession('s2')).resolves.toEqual({
        status: null,
        url: 'https://v/s2',
      });
    });

    it('returns null when Didit does not know the session', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 404 }));
      await expect(makeService().getSession('gone')).resolves.toBeNull();
    });

    it('throws on other errors', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 500 }));
      const err = await makeService()
        .getSession('s1')
        .catch((e: unknown) => e);
      expect(status(err)).toBe(500);
    });
  });
});
