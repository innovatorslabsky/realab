import { BlockList, isIP } from 'node:net';

/**
 * Address ranges a user-supplied URL must never reach: loopback, private,
 * link-local (cloud metadata lives at 169.254.169.254), CGNAT, multicast,
 * documentation and reserved space. `BlockList` also checks IPv4-mapped IPv6
 * addresses (`::ffff:7f00:1`) against the IPv4 rules.
 */
const blocked = new BlockList();

const V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: would embed an arbitrary IPv4 target
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4: embeds an IPv4 target
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

/** True when `address` is a literal IP in a range we refuse to connect to. Non-IP input returns false. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Default policy: allow only addresses outside every blocked range. */
export const publicAddressesOnly = (address: string): boolean => !isBlockedAddress(address);
