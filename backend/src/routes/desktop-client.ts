import type { FastifyInstance } from 'fastify';

/** The install's Google Desktop OAuth client, which the plugin signs people in with (D146). */
export interface DesktopClient {
  id: string;
  /** Google issues Desktop clients a secret and asks for it at the token exchange. */
  secret?: string | undefined;
}

/**
 * GET /auth/desktop-client (QOR-4713): the Desktop client's id and secret, so `/bwat:login` needs
 * nothing typed but the Google sign-in. Open: Google treats an installed app's secret as public,
 * since every copy of the app carries it, and PKCE is what protects the code. Both null when
 * the install has no Desktop client; `code_signin` true when it signs in with its code instead.
 */
export function desktopClientRoutes(
  app: FastifyInstance,
  { desktopClient, codeSignIn = false }: { desktopClient?: DesktopClient | undefined; codeSignIn?: boolean },
): void {
  app.get('/auth/desktop-client', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    // code_signin (QOR-5007): a local install signs in with its code (POST /code-signin), not Google.
    return { client_id: desktopClient?.id ?? null, client_secret: desktopClient?.secret ?? null, code_signin: codeSignIn };
  });
}

/** BWAT_GOOGLE_DESKTOP_CLIENT_ID and BWAT_GOOGLE_DESKTOP_CLIENT_SECRET; unset id: none. */
export function desktopClientFromEnv(env: NodeJS.ProcessEnv): DesktopClient | undefined {
  const id = env.BWAT_GOOGLE_DESKTOP_CLIENT_ID?.trim();
  if (!id) return undefined;
  return { id, secret: env.BWAT_GOOGLE_DESKTOP_CLIENT_SECRET?.trim() || undefined };
}
