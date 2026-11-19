import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Param,
  Patch,
  UsePipes,
  ValidationPipe,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { UserService } from './user.service';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SetAvatarDto } from './dto/set-avatar.dto';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';
import { DiditService } from '../didit/didit.service';
import { KycStatus } from './enums/kyc-status.enum';

@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly telegramLoggerService: TelegramLoggerService,
    private readonly diditService: DiditService,
  ) {}

  // Basic registration (id, first_name, last_name) happens automatically
  // on Telegram login (see AuthController) — this completes the profile
  // with the details Telegram doesn't provide.
  @Post()
  @UseGuards(ConditionalAuthGuard)
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  )
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    await this.userService.getUserOrThrow(user.id);

    return this.telegramLoggerService.trackAction(
      'User Profile Completed',
      user,
      async () => {
        await this.userService.updateProfileDetails(user.id, updateProfileDto);
        return { success: true };
      },
    );
  }

  @Get('me')
  @UseGuards(ConditionalAuthGuard)
  async getMe(@CurrentUser() user: JwtPayload) {
    const currentUser = await this.userService.getUserOrThrow(user.id);

    return {
      ...currentUser,
      is_profile_complete: this.userService.isProfileComplete(currentUser),
    };
  }

  /** Save the user's avatar seed (the app draws the picture). Returns the profile like GET /user/me. */
  @Patch('avatar')
  @UseGuards(ConditionalAuthGuard)
  async setAvatar(@CurrentUser() user: JwtPayload, @Body() body: SetAvatarDto) {
    await this.userService.getUserOrThrow(user.id);
    await this.userService.setAvatarSeed(user.id, body.seed);
    return this.getMe(user);
  }

  @Get('exists/:telegramId')
  async checkUserExists(@Param('telegramId') telegramId: string) {
    const exists = await this.userService.userExists(telegramId);
    return { registered: exists };
  }

  @Post('kyc/initiate')
  @UseGuards(ConditionalAuthGuard)
  async initiateKyc(@CurrentUser() user: JwtPayload) {
    const currentStatus = this.userService.toKycStatus(
      await this.userService.getUserOrThrow(user.id),
    );
    if (currentStatus.status === KycStatus.APPROVED) {
      throw new HttpException('KYC already verified', HttpStatus.BAD_REQUEST);
    }

    if (currentStatus.status === KycStatus.IN_REVIEW) {
      throw new HttpException(
        'KYC verification is under review',
        HttpStatus.BAD_REQUEST,
      );
    }

    // IN_PROGRESS can get stuck if Didit's final webhook never arrives. Resume
    // the existing session if Didit says it is still open; otherwise start a
    // new one instead of blocking the user forever.
    if (
      currentStatus.status === KycStatus.IN_PROGRESS &&
      currentStatus.session_id
    ) {
      const existing = await this.diditService
        .getSession(currentStatus.session_id)
        .catch(() => null);
      if (
        existing?.url &&
        (existing.status === 'Not Started' || existing.status === 'In Progress')
      ) {
        return { session_id: currentStatus.session_id, url: existing.url };
      }

      // Didit already finished this session but its webhook never reached
      // us. Record the result; a new session would throw away a passed (or
      // pending) verification, and Didit's retried webhook for the old
      // session would no longer find the user.
      if (existing?.status === 'Approved' || existing?.status === 'In Review') {
        await this.userService.applyDiditResult(user.id, currentStatus.status, {
          status: existing.status,
          verifiedName: existing.verifiedName,
        });
        throw new HttpException(
          existing.status === 'Approved'
            ? 'KYC already verified'
            : 'KYC verification is under review',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    return this.telegramLoggerService.trackAction(
      'KYC Initiation',
      user,
      async () => {
        const session = await this.diditService.createVerificationSession(
          user.id,
        );
        await this.userService.updateKycSessionId(user.id, session.session_id);
        return { session_id: session.session_id, url: session.url };
      },
    );
  }

  @Get('kyc/status')
  @UseGuards(ConditionalAuthGuard)
  async getKycStatus(@CurrentUser() user: JwtPayload) {
    const status = await this.userService.getKycStatus(user.id);

    let url: string | null = null;

    if (status.session_id) {
      const session = await this.diditService
        .getSession(status.session_id)
        .catch(() => null);
      url = session?.url ?? null;
    }

    return {
      ...status,
      url,
    };
  }
}
