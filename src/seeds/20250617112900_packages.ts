import { Knex } from 'knex';

const tableName = 'package';

export async function seed(knex: Knex): Promise<void> {
  await knex(tableName).insert([
    {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Starter Weekly',
      frequency: 'weekly',
      amount: 1000,
      currency: 'LKR',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Stacker Weekly',
      frequency: 'weekly',
      amount: 2500,
      currency: 'LKR',
    },
    {
      id: '00000000-0000-0000-0000-000000000003',
      name: 'Whale Weekly',
      frequency: 'weekly',
      amount: 5000,
      currency: 'LKR',
    },

    {
      id: '00000000-0000-0000-0000-000000000004',
      name: 'Starter Monthly',
      frequency: 'monthly',
      amount: 3000,
      currency: 'LKR',
    },
    {
      id: '00000000-0000-0000-0000-000000000005',
      name: 'Stacker Monthly',
      frequency: 'monthly',
      amount: 7000,
      currency: 'LKR',
    },
    {
      id: '00000000-0000-0000-0000-000000000006',
      name: 'Whale Monthly',
      frequency: 'monthly',
      amount: 12000,
      currency: 'LKR',
    },
  ]);
}
