export const GRID_THUMBNAIL_MIN_SIZE = 100;
export const GRID_THUMBNAIL_MAX_SIZE = 300;
export const GRID_THUMBNAIL_STEP = 20;
export const GRID_THUMBNAIL_DEFAULT_SIZE = 140;

const CONTACT_SHEET_COLUMN_GAP = 20;
const CONTACT_SHEET_ROW_GAP = 20;
const CONTACT_SHEET_TILE_GAP = 8;
const CONTACT_SHEET_LABEL_HEIGHT = 20;
const CONTACT_SHEET_MAX_WIDTH = 1400;
const CONTACT_SHEET_HORIZONTAL_PADDING = 48;
const CONTACT_SHEET_VERTICAL_PADDING = 48;
export const CONTACT_SHEET_TOP_PADDING = CONTACT_SHEET_VERTICAL_PADDING / 2;
export const CONTACT_SHEET_OVERSCAN_ROWS = 3;

export interface ContactSheetLayout {
  columns: number;
  itemSize: number;
  itemHeight: number;
  rowPitch: number;
  totalRows: number;
  maxScrollTop: number;
  firstVisibleRow: number;
  fractionalRowOffset: number;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
}

export function clampGridThumbnailSize(size: number): number {
  const boundedSize = Number.isFinite(size) ? size : GRID_THUMBNAIL_DEFAULT_SIZE;
  const clamped = Math.min(GRID_THUMBNAIL_MAX_SIZE, Math.max(GRID_THUMBNAIL_MIN_SIZE, boundedSize));
  return (
    GRID_THUMBNAIL_MIN_SIZE +
    Math.round((clamped - GRID_THUMBNAIL_MIN_SIZE) / GRID_THUMBNAIL_STEP) * GRID_THUMBNAIL_STEP
  );
}

export function calculateContactSheetLayout({
  desiredItemSize,
  contentWidth,
  viewportHeight,
  scrollTop,
  resultCount,
}: {
  desiredItemSize: number;
  contentWidth: number;
  viewportHeight: number;
  scrollTop: number;
  resultCount: number;
}): ContactSheetLayout {
  const availableWidth =
    contentWidth <= 0
      ? clampGridThumbnailSize(desiredItemSize)
      : Math.max(
          1,
          Math.min(
            CONTACT_SHEET_MAX_WIDTH,
            Math.max(1, contentWidth - CONTACT_SHEET_HORIZONTAL_PADDING)
          )
        );
  const itemSize = Math.min(clampGridThumbnailSize(desiredItemSize), availableWidth);
  const columns = Math.max(
    1,
    Math.floor((availableWidth + CONTACT_SHEET_COLUMN_GAP) / (itemSize + CONTACT_SHEET_COLUMN_GAP))
  );
  const itemHeight = itemSize + CONTACT_SHEET_TILE_GAP + CONTACT_SHEET_LABEL_HEIGHT;
  const rowPitch = itemHeight + CONTACT_SHEET_ROW_GAP;
  const totalRows = Math.ceil(resultCount / columns);
  const contentScroll = Math.max(0, scrollTop - CONTACT_SHEET_TOP_PADDING);
  const firstVisibleRow =
    totalRows === 0 ? 0 : Math.min(totalRows - 1, Math.floor(contentScroll / rowPitch));
  const fractionalRowOffset = totalRows === 0 ? 0 : (contentScroll % rowPitch) / rowPitch;
  const visibleRows = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowPitch));
  const firstRow = Math.max(0, firstVisibleRow - CONTACT_SHEET_OVERSCAN_ROWS);
  const lastRow = Math.min(totalRows, firstVisibleRow + visibleRows + CONTACT_SHEET_OVERSCAN_ROWS);
  const gridHeight = totalRows > 0 ? totalRows * rowPitch - CONTACT_SHEET_ROW_GAP : 0;
  const totalContentHeight = CONTACT_SHEET_VERTICAL_PADDING + gridHeight;

  return {
    columns,
    itemSize,
    itemHeight,
    rowPitch,
    totalRows,
    maxScrollTop: Math.max(0, totalContentHeight - Math.max(0, viewportHeight)),
    firstVisibleRow,
    fractionalRowOffset,
    startIndex: firstRow * columns,
    endIndex: Math.min(resultCount, lastRow * columns),
    topSpacerHeight: firstRow > 0 ? firstRow * rowPitch - CONTACT_SHEET_ROW_GAP : 0,
    bottomSpacerHeight:
      lastRow < totalRows ? (totalRows - lastRow) * rowPitch - CONTACT_SHEET_ROW_GAP : 0,
  };
}
