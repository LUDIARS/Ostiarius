import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export function isPrivateIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second = -1] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

/** Never guess among Wi-Fi, VPN and virtual adapters when publishing a venue address. */
export function selectLanDnsAddress(
  name: string, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  const addresses = [...new Set((interfaces[name] ?? [])
    .filter((entry) => !entry.internal && entry.family === 'IPv4' && isPrivateIpv4(entry.address))
    .map((entry) => entry.address))];
  if (addresses.length !== 1) throw new Error('LAN DNS interface must have exactly one private IPv4 address');
  return addresses[0]!;
}
