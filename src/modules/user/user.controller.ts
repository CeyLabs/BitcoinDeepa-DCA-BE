import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Param,
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
    const userExists = await this.userService.userExists(user.id);
    if (!userExists) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    const logMessage = await this.telegramLoggerService.logGenericAction(
      'User Profile Completed',
      user,
    );

    await this.userService.updateProfileDetails(user.id, updateProfileDto);

    await this.telegramLoggerService.setMessageReaction(logMessage);

    return { success: true };
  }

  @Get('me')
  @UseGuards(ConditionalAuthGuard)
  async getMe(@CurrentUser() user: JwtPayload) {
    const currentUser = await this.userService.getUserById(user.id);
    if (!currentUser) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    return {
      ...currentUser,
      is_profile_complete: this.userService.isProfileComplete(currentUser),
    };
  }

  @Get('exists/:telegramId')
  async checkUserExists(@Param('telegramId') telegramId: string) {
    const exists = await this.userService.userExists(telegramId);
    return { registered: exists };
  }

  @Post('kyc/initiate')
  @UseGuards(ConditionalAuthGuard)
  async initiateKyc(@CurrentUser() user: JwtPayload) {
    // Check if user exists
    const userExists = await this.userService.userExists(user.id);
    if (!userExists) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    // Check if user already has approved KYC or verification in progress
    const currentStatus = await this.userService.getKycStatus(user.id);
    if (currentStatus?.status === KycStatus.APPROVED) {
      throw new HttpException('KYC already verified', HttpStatus.BAD_REQUEST);
    }

    if (
      currentStatus?.status === KycStatus.IN_PROGRESS ||
      currentStatus?.status === KycStatus.IN_REVIEW
    ) {
      throw new HttpException(
        'KYC verification already in progress',
        HttpStatus.BAD_REQUEST,
      );
    }

    const logMessage = await this.telegramLoggerService.logGenericAction(
      'KYC Initiation',
      user,
    );

    try {
      // Create verification session with Didit
      const session = await this.diditService.createVerificationSession(
        user.id,
      );

      // Update user with session ID
      await this.userService.updateKycSessionId(user.id, session.session_id);

      await this.telegramLoggerService.setMessageReaction(logMessage);

      return {
        session_id: session.session_id,
        url: session.url,
      };
    } catch (error) {
      await this.telegramLoggerService.setMessageReaction(logMessage);
      throw error;
    }
  }

  @Get('kyc/status')
  @UseGuards(ConditionalAuthGuard)
  async getKycStatus(@CurrentUser() user: JwtPayload) {
    const status = await this.userService.getKycStatus(user.id);
    if (!status) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    let url: string | null = null;

    if (status.session_id) {
      try {
        const sessionDetails = await this.diditService.getSessionDetails(
          status.session_id,
        );
        url = sessionDetails?.url || null;
      } catch (error) {}
    }

    return {
      ...status,
      url,
      is_new_user: !status.session_id,
    };
  }
}
