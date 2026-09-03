// The library degrades in steps rather than reflowing, so every width is a state someone designed.
// Pure, because those states are the thing worth asserting and a ResizeObserver is not.
export type LibraryLayout = {
  showLabels: boolean;
  showSize: boolean;
  showOutputs: boolean;
  showLangs: boolean;
  showCreated: boolean;
  trayCompact: boolean;
};

export function libraryLayout(width: number): LibraryLayout {
  const tight = width < 1000;
  return {
    showLabels: !tight,
    showSize: !tight,
    showOutputs: width >= 1080,
    showLangs: width >= 1180,
    // Above every step the artboard draws: it has one date column, the app has two, and Created is
    // the one that only earns its width when nothing else needs it.
    showCreated: width >= 1320,
    trayCompact: tight,
  };
}
