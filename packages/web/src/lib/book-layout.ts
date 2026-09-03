// The book page degrades in four steps rather than reflowing, so every width is a state someone
// designed. Pure, because those states are the thing worth asserting and a ResizeObserver is not.
export type BookLayout = {
  showHeadMeta: boolean;
  showStageHint: boolean;
  showPosition: boolean;
  showWords: boolean;
  showDuration: boolean;
  showPages: boolean;
  showLabels: boolean;
  trayCompact: boolean;
  filterColumns: 1 | 2;
};

export function bookLayout(width: number): BookLayout {
  const roomy = width >= 1180;
  const tight = width < 1000;
  return {
    showHeadMeta: roomy,
    showStageHint: roomy,
    showPosition: roomy,
    showWords: width >= 1120,
    showDuration: !tight,
    showPages: !tight,
    showLabels: !tight,
    trayCompact: tight,
    filterColumns: tight ? 1 : 2,
  };
}
