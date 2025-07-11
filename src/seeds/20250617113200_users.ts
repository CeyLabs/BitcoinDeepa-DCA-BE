import type { Knex } from 'knex';

const tableName = 'user';

export async function seed(knex: Knex): Promise<void> {
  // Inserts seed entries
  await knex(tableName).insert([
    {
      id: '1241473040',
      first_name: 'Dilshan',
      last_name: 'Madushanka',
      email: 'dilshan@example.com',
      phone: '1234567890',
      address: '123 Main St',
      city: 'Colombo',
      country: 'Sri Lanka',
    },
  ]);
}
