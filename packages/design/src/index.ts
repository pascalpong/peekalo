/** Peekalo's platform-neutral visual values. Native and web own their layout adapters. */
export const tokens = {
  color: {
    background: '#151618',
    surface: '#202123',
    elevated: '#292a2c',
    text: '#efefed',
    muted: '#adaeb2',
    border: '#414246',
    accent: '#efefed',
    onAccent: '#151618',
    danger: '#ffaaa0',
    dangerSurface: '#341b1b',
    white: '#ffffff',
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
  radius: { sm: 12, md: 20, lg: 28, pill: 999 },
  type: { display: 42, title: 32, section: 18, body: 14, small: 12, caption: 10 },
  font: { display: 'PeekaloDisplay' },
} as const;

/** Use on the web root so CSS and native resolve the same semantic values. */
export const cssVariables: Record<`--pk-${string}`, string> = {};
for (const [group, values] of Object.entries(tokens)) {
  for (const [name, value] of Object.entries(values)) {
    const kebabName = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    cssVariables[`--pk-${group}-${kebabName}`] = typeof value === 'number' ? `${value}px` : value;
  }
}
