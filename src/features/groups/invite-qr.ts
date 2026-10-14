import createQrCode from 'qrcode-generator';

export function inviteQrMatrix(value: string): boolean[][] {
  const qr = createQrCode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  return Array.from({ length: qr.getModuleCount() }, (_, row) =>
    Array.from({ length: qr.getModuleCount() }, (_, column) => qr.isDark(row, column)),
  );
}

/** Merge adjacent modules, so the renderer uses one View per black run. */
export function qrDarkRuns(row: boolean[]): { start: number; length: number }[] {
  const runs: { start: number; length: number }[] = [];
  let start = 0;
  while (start < row.length) {
    if (!row[start]) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (row[end]) end += 1;
    runs.push({ start, length: end - start });
    start = end;
  }
  return runs;
}
