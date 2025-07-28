import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Param,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { User, UserService } from './user.service';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { TelegramLoggerService } from '../telegram-logger/telegram-logger.service';

@Controller('user')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly telegramLoggerService: TelegramLoggerService,
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
    const result = await this.userService.createUser({
      id: user.id,
      ...createUserDto,
    });

    await this.telegramLoggerService.logUserRegistration(user);

    return result;
  }

  @Get('exists/:telegramId')
  async checkUserExists(@Param('telegramId') telegramId: string) {
    await this.telegramLoggerService.logUserAction(
      'Initial app load (/user/exists/:telegramId)',
      { id: telegramId },
    );
    const exists = await this.userService.userExists(telegramId);
    return { registered: exists };
  }
}
