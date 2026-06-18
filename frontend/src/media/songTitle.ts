/** A throwaway-but-pleasant two-word title for a take when the user leaves the Title
 * field blank — so the row and the on-disk filename get a real name instead of the
 * (now possibly huge / JSON) prompt. Two evocative words, e.g. "Velvet Mirage". */

const ADJECTIVES = [
  'Velvet', 'Neon', 'Crimson', 'Glass', 'Midnight', 'Golden', 'Hollow', 'Electric',
  'Lunar', 'Crystal', 'Phantom', 'Sapphire', 'Wild', 'Quiet', 'Burning', 'Frozen',
  'Cosmic', 'Scarlet', 'Faded', 'Molten', 'Paper', 'Iron', 'Silent', 'Amber',
]

const NOUNS = [
  'Mirage', 'Halo', 'Cathedral', 'Tide', 'Echo', 'Bloom', 'Pulse', 'Horizon',
  'Ember', 'Drift', 'Reverie', 'Cascade', 'Vortex', 'Lullaby', 'Static', 'Aurora',
  'Monsoon', 'Eclipse', 'Requiem', 'Afterglow', 'Cinder', 'Spire', 'Solstice', 'Comet',
]

export function randomSongTitle(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`
}
