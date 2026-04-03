// pages/api/sheets/test-append.ts — Test sheet write with different approaches
import type { NextApiRequest, NextApiResponse } from 'next';
import { sheets } from '@/lib/sheets';

const SHEET_ID = '1hh3Yoh2CtShyJKYooKKwqi_6taBccEfk';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const results: Record<string, any> = {};

  // Step 1: Get spreadsheet info to see tab names and type
  try {
    const info = await sheets.spreadsheets.get({
      spreadsheetId: SHEET_ID,
    });
    results['spreadsheet_info'] = {
      title: info.data.properties?.title,
      locale: info.data.properties?.locale,
      sheets: info.data.sheets?.map((s) => ({
        title: s.properties?.title,
        index: s.properties?.index,
        sheetType: s.properties?.sheetType,
      })),
    };
  } catch (e: any) {
    results['spreadsheet_info'] = { error: e.message };
  }

  // Step 2: Try reading from the sheet first
  try {
    const read = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "'1st Report'!A1:B5",
    });
    results['read_test'] = { success: true, values: read.data.values };
  } catch (e: any) {
    results['read_test'] = { error: e.message };
  }

  // Step 3: Try append with different range formats
  const appendTests = [
    { label: 'append with tab!A:AE', range: "'1st Report'!A:AE" },
    { label: 'append with tab!A4', range: "'1st Report'!A4" },
    { label: 'append with tab name only', range: '1st Report' },
  ];

  for (const test of appendTests) {
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: test.range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [['TEST - DELETE ME', 'Test write']],
        },
      });
      results[test.label] = { success: true };
    } catch (e: any) {
      results[test.label] = { error: e.message };
    }
  }

  res.status(200).json(results);
}
