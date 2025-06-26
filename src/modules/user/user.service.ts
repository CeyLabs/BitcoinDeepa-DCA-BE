import { Injectable } from '@nestjs/common';
import { KnexService } from '../knex/knex.service';

export interface User {
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
}

@Injectable()
export class UserService {
  constructor(private readonly knexService: KnexService) {}

  async createUser(createUserDto: User): Promise<void> {
    await this.knexService.knex('user').insert(createUserDto);
  }

  async getUserById(id: string): Promise<User | undefined> {
    return await this.knexService.knex<User>('user').where('id', id).first();
  }
}
