import { Knex } from 'knex';

const tableName = 'subscription';

export async function seed(knex: Knex): Promise<void> {
  await knex(tableName).insert([
    {
      id: '10000000-0000-0000-0000-000000000001',
      user_id: '1241473040',
      package_id: '00000000-0000-0000-0000-000000000001', // Starter Weekly
    },
  ]);
}
