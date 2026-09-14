// The least a row needs to be sectioned. Structural rather than an import of the component's own
// option type, so this stays a plain list rule the dropdown happens to use.
export type Sectionable = { group?: string };

// Sections are contiguous runs in the caller's order, not a lookup by group name. Callers append
// rows that belong after the grouped ones — the model pickers' "Show all" — and a name-keyed
// grouping pulls those into whichever section shares their (empty) group, which is the first one:
// the row that reveals the rest of the list ends up rendering above it instead.
export function sectionsOf<T extends Sectionable>(options: T[]): { group: string; options: T[] }[] {
  const sections: { group: string; options: T[] }[] = [];
  for (const option of options) {
    const group = option.group ?? "";
    const last = sections[sections.length - 1];
    if (last && last.group === group) last.options.push(option);
    else sections.push({ group, options: [option] });
  }
  return sections;
}
