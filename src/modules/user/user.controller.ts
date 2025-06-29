import { Controller, Post, Body } from '@nestjs/common';
import { User, UserService } from './user.service';
import { CurrentUser } from '../auth/user.decorator';
import { JwtPayload } from '../auth/auth.service';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
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
