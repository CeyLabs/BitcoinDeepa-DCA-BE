import { IsString, Matches } from 'class-validator';

/** PATCH /user/avatar: the seed of the avatar the app drew (1–64 of [A-Za-z0-9_-]). */
export class SetAvatarDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, {
    message: 'seed must be 1-64 letters, digits, - or _',
  })
  seed: string;
}
