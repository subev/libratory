// The book page's chrome degrades in steps rather than reflowing, so every width is a state someone
// designed. The chapter table is not part of it: a narrow window scrolls the table sideways rather
// than dropping columns, because a dropped column hid its data with no way to reach it. Pure,
// because those states are the thing worth asserting and a ResizeObserver is not.
export type BookLayout = {
  showHeadMeta: boolean;
  showStageHint: boolean;
  showPosition: boolean;
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
    showLabels: !tight,
    trayCompact: tight,
    filterColumns: tight ? 1 : 2,
  };
}
