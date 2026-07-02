import type { BrowserItem, BrowserLeafRow, BrowserTreeRow } from "./browser-types";

export const createBrowserLeafRow = (item: BrowserItem): BrowserLeafRow => ({
  kind: "leaf",
  item,
});

export const countBrowserTreeLeaves = (rows: BrowserTreeRow[]): number => {
  let count = 0;
  for (const row of rows) {
    count += row.kind === "leaf" ? 1 : countBrowserTreeLeaves(row.children);
  }
  return count;
};

export const filterBrowserTreeRows = (rows: BrowserTreeRow[], query: string): BrowserTreeRow[] => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return rows;

  const filteredRows: BrowserTreeRow[] = [];
  for (const row of rows) {
    if (row.kind === "leaf") {
      if (row.item.searchText.includes(normalizedQuery)) filteredRows.push(row);
      continue;
    }

    const matchingChildren = filterBrowserTreeRows(row.children, normalizedQuery);
    if (row.searchText.includes(normalizedQuery)) {
      filteredRows.push(row);
      continue;
    }
    if (matchingChildren.length > 0) {
      filteredRows.push({ ...row, children: matchingChildren });
    }
  }
  return filteredRows;
};
