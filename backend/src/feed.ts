import { createHmac } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { key32 } from './config.ts';

/**
 * BWAT_FEED_KEY (QOR-4582): 32 bytes every feed token is derived from, read
 * once at boot. Required in production; unset elsewhere, the claim view carries no token.
 */
export function feedKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const value = env.BWAT_FEED_KEY;
  if (!value) {
    if (env.NODE_ENV === 'production') throw new Error('BWAT_FEED_KEY is required when NODE_ENV=production');
    return undefined;
  }
  return key32('BWAT_FEED_KEY', value);
}

/** A claim generation's feed token: derived, so nothing is stored; a new generation gets a new one. */
export const feedToken = (key: Buffer, claimId: string, generation: number) =>
  `bwo_${createHmac('sha256', key).update(`${claimId}|${generation}`).digest('base64url')}`;

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8);
PRIVATE.addSubnet('172.16.0.0', 12);
PRIVATE.addSubnet('192.168.0.0', 16);

/**
 * Where a bot may say it serves the feed: a private IPv4 literal (10/8, 172.16/12,
 * 192.168/16), as an ECS task or a compose container has. Names, public, loopback and
 * link-local addresses (the metadata service, 169.254.169.254) are refused, and so is
 * every IPv6 address but an IPv4-mapped private one (fd00:ec2::254 is the IPv6 metadata
 * service). Capture checks again before it dials.
 */
export function feedHostAllowed(host: string): boolean {
  const family = isIP(host);
  return family !== 0 && PRIVATE.check(host, family === 4 ? 'ipv4' : 'ipv6');
}
