import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import {
  normalizeUsername,
  USERNAME_PATTERN,
  USERNAME_RULE,
} from '../username';

/** POST /user/username and GET /user/username/availability */
export class ClaimUsernameDto {
  @Transform(({ value }) => normalizeUsername(value))
  @IsString()
  @Matches(USERNAME_PATTERN, { message: USERNAME_RULE })
  username: string;
}

/** The availability check answers for any input (invalid ones say why) */
export class UsernameQueryDto {
  @Transform(({ value }) => normalizeUsername(value))
  @IsString()
  username: string;
}
