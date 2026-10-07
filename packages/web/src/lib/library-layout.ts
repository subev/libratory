// The library's chrome degrades in steps rather than reflowing, so every width is a state someone
// designed. The book table is not part of it: a narrow pane scrolls the table sideways rather than
// dropping columns, as the chapter table does. Pure, because those states are the thing worth
// asserting and a ResizeObserver is not.
export type LibraryLayout = {
  showLabels: boolean;
  trayCompact: boolean;
};

export function libraryLayout(width: number): LibraryLayout {
  const tight = width < 1000;
  return {
    showLabels: !tight,
    trayCompact: tight,
  };
}
