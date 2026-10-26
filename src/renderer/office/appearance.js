export const HAIR_STYLES = ['none', 'crop', 'sidepart', 'curly', 'spiky', 'bun'];
export const ACCESSORIES = ['none', 'glasses', 'round-glasses', 'cap', 'beanie', 'bow', 'headset'];
const HAIR_COLORS = ['#493d3b', '#795744', '#c49965', '#645c82', '#a25e50', '#657c72'];

// Choose once when an actor enters; frame rendering never changes their appearance.
export function createAppearance(random = Math.random) {
  const pick = values => values[Math.min(values.length - 1, Math.max(0, Math.floor(random() * values.length)))];
  return { hair: pick(HAIR_STYLES), accessory: pick(ACCESSORIES), hairColor: pick(HAIR_COLORS) };
}
