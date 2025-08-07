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
import { CreateUserDto } from './dto/create-user.dto';
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
  async createUser(
    @CurrentUser() user: JwtPayload,
    @Body() createUserDto: CreateUserDto,
  ) {
    const logMessage = await this.telegramLoggerService.logGenericAction(
      'User Registration',
      user,
    );

    const result = await this.userService.createUser({
      id: user.id,
      ...createUserDto,
    });

    await this.telegramLoggerService.setMessageReaction(logMessage);

    return result;
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
        verification_url: session.verification_url,
        expires_at: session.expires_at,
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
    return status;
  }
}
