// Small stroke icons, 16px grid, drawn with currentColor.

type P = { size?: number };

const Svg = ({ size = 16, children }: P & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" />
  </Svg>
);

export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 3.5v9M10.5 3.5v9" strokeWidth="2" />
  </Svg>
);

export const IconExpand = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
  </Svg>
);

export const IconCollapse = (p: P) => (
  <Svg {...p}>
    <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />
  </Svg>
);

export const IconSound = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
    <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
  </Svg>
);

export const IconMuted = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
    <path d="M11 6l3 4M14 6l-3 4" />
  </Svg>
);

export const IconOpen = (p: P) => (
  <Svg {...p}>
    <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3.5H3a1 1 0 0 0-1 1z" />
  </Svg>
);

export const IconExport = (p: P) => (
  <Svg {...p}>
    <path d="M8 10V2.5M5 5.5l3-3 3 3M3 9.5v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
  </Svg>
);

export const IconChevron = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 6.5L8 10l3.5-3.5" />
  </Svg>
);

export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </Svg>
);

export const IconMic = (p: P) => (
  <Svg {...p}>
    <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
    <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
  </Svg>
);

export const IconStop = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
  </Svg>
);

export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Svg>
);

export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 3L2.5 6l3 3" />
    <path d="M2.5 6h6.5a4 4 0 0 1 0 8H6" />
  </Svg>
);

export const IconUpDown = (p: P) => (
  <Svg {...p}>
    <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);
