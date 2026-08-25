/**
 * icons.tsx — the design doc's icon set (0b): 24 grid, 1.8–2.2 stroke, no fills.
 * Paths are transcribed from the spec sheet so the phone matches it exactly.
 */
interface P { size?: number; className?: string; stroke?: string; }

const Svg = ({ size = 22, className, stroke = 'currentColor', width, children }: P & { width?: number; children: React.ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={width ?? 2}
    strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden focusable="false">
    {children}
  </svg>
);

/**
 * The official Claude symbol — the same path as public/icons/claude-symbol.svg (Anthropic's,
 * via Wikimedia Commons, CC0). Filled, not stroked, so it does not go through <Svg>; it is a
 * brand mark rather than a member of the icon set, and must not be restyled.
 */
export const ClaudeMark = ({ size = 22, className, fill = 'currentColor' }: { size?: number; className?: string; fill?: string }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" fill={fill} className={className} aria-hidden focusable="false">
    <path d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z" />
  </svg>
);

export const Back = (p: P) => <Svg {...p} width={2.2}><path d="M14.5 5 8 12l6.5 7" /></Svg>;
export const Dots = (p: P) => (
  <svg width={p.size ?? 22} height={p.size ?? 22} viewBox="0 0 24 24" fill="currentColor" className={p.className} aria-hidden focusable="false">
    <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
  </svg>
);
export const Plus = (p: P) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const Close = (p: P) => <Svg {...p} width={2.2}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
export const Lock = (p: P) => <Svg {...p} width={2.1}><rect x="4" y="10.5" width="16" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></Svg>;
export const Help = (p: P) => <Svg {...p} width={2.1}><circle cx="12" cy="12" r="8.6" /><path d="M9.5 9.4a2.6 2.6 0 0 1 5.1.7c0 1.7-2.5 2.2-2.5 3.8M12 17.2v.01" /></Svg>;
/** Leaving, not configuring: a door with the arrow already through it. Deliberately not a gear —
 * the gear promised settings this screen does not have. */
export const SignOut = (p: P) => <Svg {...p} width={2.1}><path d="M9.5 20.5H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h3.5" /><path d="m16 16.5 5-4.5-5-4.5M21 12H9.5" /></Svg>;
export const Branch = (p: P) => <Svg {...p} width={2.2}><circle cx="7" cy="6" r="2.6" /><circle cx="7" cy="18" r="2.6" /><circle cx="17" cy="12" r="2.6" /><path d="M7 8.6v6.8M9.6 6h2.4a2.4 2.4 0 0 1 2.4 2.4v1.2" /></Svg>;
export const Check = (p: P) => <Svg {...p} width={2.4}><path d="M5 13l4 4L19 7" /></Svg>;
export const ArrowDown = (p: P) => <Svg {...p} width={2.2}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>;
export const ArrowUp = (p: P) => <Svg {...p} width={2.4}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
export const Copy = (p: P) => <Svg {...p} width={2.1}><rect x="9" y="9" width="11" height="11" rx="2.4" /><path d="M15 5.5H6.4A2.4 2.4 0 0 0 4 7.9v8.6" /></Svg>;
export const WifiOff = (p: P) => <Svg {...p} width={2.2}><path d="M4 4l16 16M8.5 15.5a5 5 0 0 1 7 0M12 19.5v.01" /></Svg>;
export const Alert = (p: P) => <Svg {...p} width={2.1}><path d="M12 8v5M12 16.5v.01" /><circle cx="12" cy="12" r="8.6" /></Svg>;
export const Info = (p: P) => <Svg {...p} width={2.2}><circle cx="12" cy="12" r="8.5" /><path d="M12 8.2v.2M12 11.5v4.3" /></Svg>;
export const ChevronDown = (p: P) => <Svg {...p} width={2.2}><path d="m8 10 4 4 4-4" /></Svg>;
export const Gear = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></Svg>;
export const Pencil = (p: P) => <Svg {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /></Svg>;
/** Language. A globe rather than a flag: a language is not a country, and picking one flag for
 * English (or for Chinese) is a choice with no right answer. */
export const Globe = (p: P) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.4 3.8 5.5 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.5-3.8-9S9.5 5.4 12 3Z" /></Svg>;
export const Trash = (p: P) => <Svg {...p} width={2}><path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 10.5v6M14 10.5v6" /></Svg>;
export const Doc = (p: P) => <Svg {...p}><path d="M6 3h7l5 5v13H6z" /></Svg>;
export const Brain = (p: P) => <Svg {...p} width={1.8}><path d="M9.5 4.5A3.5 3.5 0 0 0 6 8v.6A3 3 0 0 0 5 14v1a3 3 0 0 0 3 3h1.5M14.5 4.5A3.5 3.5 0 0 1 18 8v.6A3 3 0 0 1 19 14v1a3 3 0 0 1-3 3h-1.5M12 4v16" /></Svg>;
export const Picture = (p: P) => <Svg {...p} width={2}><rect x="3.5" y="5" width="17" height="14" rx="2.4" /><circle cx="8.8" cy="10" r="1.5" /><path d="m4.5 17.5 4.8-4.8 3 3L15.8 12l3.7 3.7" /></Svg>;
export const Terminal = (p: P) => <Svg {...p} width={2}><path d="M4 5h16v14H4zM8 10l2 2-2 2M13 14h4" /></Svg>;
