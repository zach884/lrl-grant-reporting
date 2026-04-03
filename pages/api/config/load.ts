// pages/api/config/load.ts — Load and cache config sheet data
import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfig, clearConfigCache } from '@/lib/config';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const forceRefresh = req.query.refresh === 'true';
    if (forceRefresh) {
      clearConfigCache();
    }
    const config = await getConfig(forceRefresh);
    res.status(200).json(config);
  } catch (error: any) {
    console.error('Config load error:', error);
    res.status(500).json({ error: error.message ?? 'Failed to load config' });
  }
}
