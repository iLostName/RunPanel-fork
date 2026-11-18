/**
 * Whether a set of seeds fits where it is going. Zero imports: the unit suite
 * loads this file directly.
 *
 * Disks and not paths: two destinations on one disk share its free space, and
 * then it is the sum of what they need that has to fit. The archive of each copy
 * also passes through the panel's own tmp, one at a time, and costs its size on
 * top of everything already written when that is the same disk.
 */

export interface SeedEstimate {
  place: string;
  disk: string;
  neededKb: number;
  freeKb: number;
}

export interface ScratchSpace {
  place: string;
  disk: string;
  freeKb: number;
}

export interface SpaceShortfall {
  place: string;
  neededKb: number;
}

const MARGIN = 1.05;

export function spaceShortfall(seeds: SeedEstimate[], scratch: ScratchSpace | null): SpaceShortfall | null {
  const onDisk = new Map<string, number>();

  for (const seed of seeds) {
    const total = (onDisk.get(seed.disk) ?? 0) + seed.neededKb;
    onDisk.set(seed.disk, total);
    if (seed.freeKb < total * MARGIN) return { place: seed.place, neededKb: total };
  }

  if (scratch && seeds.length > 0) {
    const largest = Math.max(...seeds.map((seed) => seed.neededKb));
    const total = largest + (onDisk.get(scratch.disk) ?? 0);
    if (scratch.freeKb < total * MARGIN) return { place: scratch.place, neededKb: total };
  }

  return null;
}
