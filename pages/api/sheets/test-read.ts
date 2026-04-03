// pages/api/sheets/test-read.ts — Check what was written to the sheet
import type { NextApiRequest, NextApiResponse } from 'next';
import { sheets } from '@/lib/sheets';

const SHEET_ID = '1rDKhIF7yApYcO-qY9yAVSYm4zD6Sb1zMzj4H2HuPKIk';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  // Get spreadsheet metadata
  try {
    const info = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    results['tabs'] = info.data.sheets?.map((s) => ({
      title: s.properties?.title,
      rowCount: s.properties?.gridProperties?.rowCount,
      colCount: s.properties?.gridProperties?.columnCount,
    }));
  } catch (e: any) {
    results['meta_error'] = e.message;
  }

  // Read last 10 rows of 1st Report
  try {
    const data = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "'1st Report'!A1:AE20",
    });
    results['1st_report_rows'] = data.data.values?.length ?? 0;
    results['1st_report_data'] = data.data.values;
  } catch (e: any) {
    results['1st_report_error'] = e.message;
  }

  // Read last 10 rows of Cumulative Report
  try {
    const data = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "'Cumulative Report'!A1:AE20",
    });
    results['cumulative_rows'] = data.data.values?.length ?? 0;
    results['cumulative_data'] = data.data.values;
  } catch (e: any) {
    results['cumulative_error'] = e.message;
  }

  res.status(200).json(results);
}
