import { Controller, Post, Body, UseGuards, Get, Param, UsePipes, ValidationPipe } from '@nestjs/common';
import { User, UserService } from './user.service';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @UseGuards(ConditionalAuthGuard)
  @UsePipes(new ValidationPipe({ 
    whitelist: true, 
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true } 
  }))
  async createUser(
    @CurrentUser() user: JwtPayload,
    @Body() createUserDto: CreateUserDto,
  ) {
    return await this.userService.createUser({
      id: user.user_id,
      ...createUserDto,
    });
  }

  @Get('exists/:telegramId')
  async checkUserExists(@Param('telegramId') telegramId: string) {
    const exists = await this.userService.userExists(telegramId);
    return { registered: exists };
  }
}
