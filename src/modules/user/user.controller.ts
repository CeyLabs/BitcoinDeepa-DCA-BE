import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { User, UserService } from './user.service';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { ConditionalAuthGuard } from '../auth/conditional-auth.guard';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @UseGuards(ConditionalAuthGuard)
  async createUser(
    @CurrentUser() user: JwtPayload,
    @Body() createUserDto: Omit<User, 'id'>,
  ) {
    return await this.userService.createUser({
      id: user.user_id,
      ...createUserDto,
    });
  }
}
