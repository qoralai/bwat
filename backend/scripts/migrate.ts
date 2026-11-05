/**
 * `npm run migrate`: applies backend/migrations to the database in BWAT_OWNER_DB_URL
 * (BWAT_OWNER_DB_URL_FILE > BWAT_OWNER_DB_URL > aws `<prefix>BWAT_OWNER_DB_URL`), as the
 * owner role. Prints the files it applied; never prints the URL. Loads the AWS SDK only
 * when BWAT_SECRET_STORE=aws.
 */
import { dbTls, ownerDbUrl, STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { migrateDatabase } from '../src/db/migrate.ts';

try {
  const warn = ({ name, winner }: { name: string; winner: string }) => console.warn(`warning: ${name} is set in more than one place; using ${winner}`);
  const env = await startupEnv(process.env, STARTUP_NAMES.migrate, { warn });
  const applied = await migrateDatabase(ownerDbUrl(env), undefined, { ssl: dbTls(env) });
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply');
} catch (err) {
  console.error(`migrate failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
