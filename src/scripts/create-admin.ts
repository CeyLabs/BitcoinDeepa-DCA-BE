/**
 * Create an admin who can sign in to the admin dashboard.
 *
 *   bun run admin:create --email admin@example.com --name "Jane Doe"
 *   node dist/src/scripts/create-admin.js --email ... --name ...   (production build)
 *
 * The password is asked for interactively (hidden), or read from
 * ADMIN_PASSWORD for non-interactive use.
 */
import { createInterface } from 'readline';
import { Writable } from 'stream';
import { createAdminAuth } from '../modules/admin/auth/admin-auth.config';
import { createAdminAuthPool } from '../modules/admin/auth/admin-auth.module';
import { ADMIN_ROLE } from '../modules/admin/auth/admin-auth.constants';
import { errorMessage } from '../common/error-message';

const MIN_PASSWORD_LENGTH = 12;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  if (!email || !name) {
    throw new Error(
      'Usage: bun run admin:create --email <email> --name "<full name>"',
    );
  }

  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await askHidden(`Password (min ${MIN_PASSWORD_LENGTH} chars): `);
    const confirm = await askHidden('Confirm password: ');
    if (password !== confirm) throw new Error('Passwords do not match');
  }
  // Server-side createUser skips Better Auth's minPasswordLength check
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }

  const pool = createAdminAuthPool();
  try {
    const auth = await createAdminAuth({
      pool,
      secret: process.env.BETTER_AUTH_SECRET,
      baseURL:
        process.env.BETTER_AUTH_URL ??
        `http://localhost:${process.env.PORT ?? 3000}`,
      production: process.env.NODE_ENV === 'production',
    });
    // Server-side call without a session: the admin plugin allows this, and
    // it bypasses disableSignUp.
    const { user } = await auth.api.createUser({
      body: { email, password, name, role: ADMIN_ROLE },
    });
    console.log(`Admin created: ${user.email} (${user.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Failed to create admin: ${errorMessage(error)}`);
  process.exit(1);
});
