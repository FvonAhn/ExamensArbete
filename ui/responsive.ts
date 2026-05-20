export const MOBILE_BREAKPOINT = 768;
export const COMPACT_BREAKPOINT = 900;

export type ResponsiveLayout = {
  width: number;
  prefersCompactUi: boolean;
  isMobile: boolean;
  isTablet: boolean;
  isCompact: boolean;
  allowPopouts: boolean;
};

export function detectCompactPreference(win: Window): boolean {
  return win.matchMedia("(hover: none), (pointer: coarse)").matches;
}

export function classifyResponsiveLayout(
  width: number,
  prefersCompactUi: boolean,
): ResponsiveLayout {
  const isMobile = width > 0 && width < MOBILE_BREAKPOINT;
  const isTablet = width >= MOBILE_BREAKPOINT && (width <= COMPACT_BREAKPOINT || prefersCompactUi);
  const isCompact = isMobile || isTablet;

  return {
    width,
    prefersCompactUi,
    isMobile,
    isTablet,
    isCompact,
    allowPopouts: width > COMPACT_BREAKPOINT && !prefersCompactUi,
  };
}

export function getWindowResponsiveLayout(win: Window): ResponsiveLayout {
  return classifyResponsiveLayout(win.innerWidth, detectCompactPreference(win));
}

export function isCompactDialogLayout(win: Window): boolean {
  return getWindowResponsiveLayout(win).isCompact;
}
