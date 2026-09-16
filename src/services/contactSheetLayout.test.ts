import { describe, expect, it } from 'vitest';
import {
  calculateContactSheetLayout,
  clampGridThumbnailSize,
  GRID_THUMBNAIL_DEFAULT_SIZE,
} from './contactSheetLayout';

describe('contact sheet layout', () => {
  it('clamps zoom to the supported 20px steps and defaults to 140px', () => {
    expect(GRID_THUMBNAIL_DEFAULT_SIZE).toBe(140);
    expect(clampGridThumbnailSize(70)).toBe(100);
    expect(clampGridThumbnailSize(151)).toBe(160);
    expect(clampGridThumbnailSize(350)).toBe(300);
  });

  it('uses one row pitch for tile, label, row gap, and virtual spacers', () => {
    const layout = calculateContactSheetLayout({
      desiredItemSize: 140,
      contentWidth: 1296,
      viewportHeight: 600,
      scrollTop: 24 + 10 * 188 + 47,
      resultCount: 10_000,
    });

    expect(layout.columns).toBe(7);
    expect(layout.itemHeight).toBe(168);
    expect(layout.rowPitch).toBe(188);
    expect(layout.firstVisibleRow).toBe(10);
    expect(layout.fractionalRowOffset).toBeCloseTo(47 / 188);
    expect(layout.topSpacerHeight + 20).toBe((layout.startIndex / layout.columns) * 188);
    expect(layout.endIndex).toBeLessThan(10_000);
    expect(layout.endIndex - layout.startIndex).toBeLessThan(100);
  });

  it('keeps one column on a narrow viewport and safely lays out empty results', () => {
    const narrow = calculateContactSheetLayout({
      desiredItemSize: 300,
      contentWidth: 100,
      viewportHeight: 200,
      scrollTop: 0,
      resultCount: 2,
    });
    const empty = calculateContactSheetLayout({
      desiredItemSize: 140,
      contentWidth: 900,
      viewportHeight: 200,
      scrollTop: 1_000,
      resultCount: 0,
    });

    expect(narrow.columns).toBe(1);
    expect(narrow.itemSize).toBe(52);
    expect(empty.totalRows).toBe(0);
    expect(empty.startIndex).toBe(0);
    expect(empty.endIndex).toBe(0);
    expect(empty.maxScrollTop).toBe(0);
  });

  it('preserves a fractional visible-row anchor when the column count changes', () => {
    const oldLayout = calculateContactSheetLayout({
      desiredItemSize: 140,
      contentWidth: 1_296,
      viewportHeight: 500,
      scrollTop: 24 + 40 * 188 + 94,
      resultCount: 10_000,
    });
    const anchorIndex = oldLayout.firstVisibleRow * oldLayout.columns;
    const nextLayout = calculateContactSheetLayout({
      desiredItemSize: 300,
      contentWidth: 1_296,
      viewportHeight: 500,
      scrollTop: 0,
      resultCount: 10_000,
    });
    const nextAnchorRow = Math.floor(anchorIndex / nextLayout.columns);
    const anchoredScroll = Math.min(
      nextLayout.maxScrollTop,
      24 + nextAnchorRow * nextLayout.rowPitch + oldLayout.fractionalRowOffset * nextLayout.rowPitch
    );
    const resolved = calculateContactSheetLayout({
      desiredItemSize: 300,
      contentWidth: 1_296,
      viewportHeight: 500,
      scrollTop: anchoredScroll,
      resultCount: 10_000,
    });

    expect(nextLayout.columns).toBeLessThan(oldLayout.columns);
    expect(resolved.firstVisibleRow).toBe(nextAnchorRow);
    expect(resolved.fractionalRowOffset).toBeCloseTo(oldLayout.fractionalRowOffset);
  });
});
