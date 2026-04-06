// pages/api/sheets/read-headers.ts — Read headers from a reporting sheet for config setup
import type { NextApiRequest, NextApiResponse } from 'next';
import { sheets } from '@/lib/sheets';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sheetId = (req.query.sheetId as string) || '1IBk0l4zC1JVuPDot1ZRdJEDlLFD0FT2WSDf28fn0sC4';
  const headerRow = parseInt(req.query.headerRow as string || '3', 10);

  try {
    // Get spreadsheet metadata
    const info = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
    const tabs = info.data.sheets?.map((s) => ({
      title: s.properties?.title,
      index: s.properties?.index,
    })) ?? [];

    // Read header rows from specified tab (defaults to first data tab, skipping Instructions)
    const tabParam = req.query.tab as string | undefined;
    const tabName = tabParam || tabs.find((t) => t.title?.includes('SB Data') || t.title?.includes('Report'))?.title || tabs[0]?.title || 'Sheet1';
    const headerData = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `'${tabName}'!A1:BZ${headerRow}`,
    });

    const rows = headerData.data.values ?? [];

    // Build column map: column letter → header text
    const columns: { letter: string; headers: string[] }[] = [];
    const maxCols = Math.max(...rows.map((r) => r.length));

    for (let i = 0; i < maxCols; i++) {
      const letter = numToCol(i + 1);
      const headers: string[] = [];
      for (let r = 0; r < rows.length; r++) {
        headers.push((rows[r]?.[i] ?? '').toString().trim());
      }
      columns.push({ letter, headers });
    }

    res.status(200).json({
      sheetId,
      tabs,
      headerRow,
      columns,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

function numToCol(num: number): string {
  let col = '';
  while (num > 0) {
    const mod = (num - 1) % 26;
    col = String.fromCharCode(65 + mod) + col;
    num = Math.floor((num - 1) / 26);
  }
  return col;
}
