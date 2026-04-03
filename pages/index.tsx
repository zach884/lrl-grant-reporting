// pages/index.tsx — Main app entry, reads GHL iframe params
import { useEffect, useState } from 'react';
import { parseGHLContext } from '@/lib/auth';
import type { GHLUser } from '@/types';

export default function Home() {
  const [user, setUser] = useState<GHLUser | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setUser(parseGHLContext(params));
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          LRL Activity Tracker
        </h1>
        {user && (
          <p className="text-sm text-gray-500 mb-6">
            Logged in as {user.userName || 'Unknown'}{' '}
            {user.isAdmin && (
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                Admin
              </span>
            )}
          </p>
        )}
        <p className="text-gray-600">
          Config loader is ready. Hit{' '}
          <code className="bg-gray-200 px-1 py-0.5 rounded text-sm">
            /api/config/test
          </code>{' '}
          to verify the config sheet data.
        </p>
      </div>
    </main>
  );
}
