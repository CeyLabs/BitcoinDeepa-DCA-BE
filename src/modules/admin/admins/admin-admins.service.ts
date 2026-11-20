import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { KnexService } from '../../knex/knex.service';
import type { AdminAuth } from '../auth/admin-auth.config';
import { ADMIN_AUTH, ADMIN_ROLE } from '../auth/admin-auth.constants';
import type { CreateAdminDto } from './dto/create-admin.dto';

export interface AdminUserView {
  id: string;
  name: string;
  email: string;
  banned: boolean;
  createdAt: string;
}

type Row = {
  id: string;
  name: string;
  email: string;
  banned: boolean | null;
  created_at: Date;
};

const toView = (row: Row): AdminUserView => ({
  id: row.id,
  name: row.name,
  email: row.email,
  banned: row.banned ?? false,
  createdAt: row.created_at.toISOString(),
});

@Injectable()
export class AdminAdminsService {
  constructor(
    private readonly db: KnexService,
    @Inject(ADMIN_AUTH) private readonly auth: AdminAuth,
  ) {}

  /** Every dashboard admin, oldest first (a short list: no paging). */
  async list(): Promise<AdminUserView[]> {
    const rows = await this.db
      .knex('admin_user')
      .select<Row[]>('id', 'name', 'email', 'banned', 'created_at')
      .where('role', ADMIN_ROLE)
      .orderBy([
        { column: 'created_at', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);
    return rows.map(toView);
  }

  async create({ email, name, password }: CreateAdminDto) {
    const existing = await this.db
      .knex('admin_user')
      .whereRaw('lower(email) = ?', [email])
      .first<{ id: string } | undefined>('id');
    if (existing) {
      throw new ConflictException('An admin with this email already exists');
    }
    // Server-side call (no headers): bypasses disableSignUp, like admin:create.
    // The caller is already checked by AdminSessionGuard.
    const { user } = await this.auth.api.createUser({
      body: { email, password, name, role: ADMIN_ROLE },
    });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      banned: false,
      createdAt: new Date(user.createdAt).toISOString(),
    } satisfies AdminUserView;
  }
}
