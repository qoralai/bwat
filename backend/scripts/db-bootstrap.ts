/**
 * `npm run db-bootstrap` (`node dist/scripts/db-bootstrap.js` in the image): creates the
 * three database logins and the database from an admin connection, re-runnably. Reads
 * BWAT_DB_ADMIN_URL, or BWAT_DB_ADMIN_USER, _PASSWORD, _HOST and _PORT (each NAME_FILE >
 * NAME, never the store); BWAT_OWNER_PASSWORD, BWAT_RUNTIME_PASSWORD, BWAT_CARDS_PASSWORD
 * (each NAME_FILE > NAME > aws `<prefix>NAME`); BWAT_DB_NAME (default bwat); and
 * BWAT_DB_SSLROOTCERT for TLS. Prints
 * created or kept per object; never prints a URL or a password. Loads the AWS SDK only
 * when BWAT_SECRET_STORE=aws.
 */
import { STARTUP_NAMES, startupEnv } from '../src/config.ts';
import { dbBootstrap } from '../src/db/bootstrap.ts';

try {
  const warn = ({ name, winner }: { name: string; winner: string }) => console.warn(`warning: ${name} is set in more than one place; using ${winner}`);
  for (const line of await dbBootstrap(await startupEnv(process.env, STARTUP_NAMES.dbBootstrap, { warn }))) console.log(line);
} catch (err) {
  console.error(`db-bootstrap failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
