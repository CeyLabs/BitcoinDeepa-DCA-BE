import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PayHereLinkDto } from './payhere-link.dto';

const isValid = (package_id: unknown) =>
  validateSync(plainToInstance(PayHereLinkDto, { package_id })).length === 0;

describe('PayHereLinkDto', () => {
  it('accepts the production-style package ids', () => {
    expect(isValid('00000000-0000-0000-0000-000000000001')).toBe(true);
  });

  it('accepts regular v4 uuids', () => {
    expect(isValid('9b2f7c1e-4a3d-4e8b-9c1a-2f3e4d5c6b7a')).toBe(true);
  });

  it('rejects anything that is not uuid-shaped', () => {
    expect(isValid('not-a-uuid')).toBe(false);
    expect(isValid('')).toBe(false);
    expect(isValid(undefined)).toBe(false);
    expect(isValid("1' OR '1'='1")).toBe(false);
  });
});
