// pages/api/config/test.ts — Test endpoint to verify config sheet data shape
import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfig } from '@/lib/config';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const config = await getConfig(true); // always force-refresh for testing

    // Return config data with row counts for quick verification
    res.status(200).json({
      success: true,
      summary: {
        referralTypeGrantMapping: config.referralTypeGrantMapping.length,
        grantSheetMapping: config.grantSheetMapping.length,
        fieldMapping: config.fieldMapping.length,
        reportingPeriods: config.reportingPeriods.length,
      },
      data: config,
    });
  } catch (error: any) {
    console.error('Config test error:', error);
    res.status(500).json({
      success: false,
      error: error.message ?? 'Unknown error',
      hint: 'Check that GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, and CONFIG_SHEET_ID are set in .env.local',
    });
  }
}
