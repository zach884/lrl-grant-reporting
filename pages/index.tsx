// pages/index.tsx — Main app entry, reads GHL iframe params
import { useEffect, useState } from 'react';
import { parseGHLContext } from '@/lib/auth';
import ActivityForm from '@/components/ActivityForm';
import ActivityList from '@/components/ActivityList';
import type { GHLUser, FieldOption } from '@/types';

export default function Home() {
  const [user, setUser] = useState<GHLUser | null>(null);
  const [activeTab, setActiveTab] = useState<'log' | 'dashboard'>('log');
  const [refreshKey, setRefreshKey] = useState(0);

  const [activityTypeOptions, setActivityTypeOptions] = useState<FieldOption[]>([]);
  const [referralTypeOptions, setReferralTypeOptions] = useState<FieldOption[]>([]);
  const [grantOptions, setGrantOptions] = useState<FieldOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setUser(parseGHLContext(params));
    loadFieldOptions();
  }, []);

  async function loadFieldOptions() {
    setOptionsLoading(true);
    try {
      const res = await fetch('/api/fields/options');
      if (!res.ok) throw new Error('Failed to load field options');
      const data = await res.json();
      setActivityTypeOptions(data.activity_type ?? []);
      setReferralTypeOptions(data.referral_type ?? []);
      setGrantOptions(data.program__grant_association ?? []);
    } catch (err: any) {
      setOptionsError(err.message);
    } finally {
      setOptionsLoading(false);
    }
  }

  function handleActivitySuccess() {
    setRefreshKey((k) => k + 1);
  }

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <h1 className="text-lg font-bold text-gray-900">LRL Activity Tracker</h1>
          {user && (
            <span className="text-sm text-gray-500">
              {user.userName || 'Unknown'}{' '}
              {user.isAdmin && (
                <span className="text-xs bg-[#f8b932]/20 text-[#b8860b] px-2 py-0.5 rounded">
                  Admin
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto flex">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              activeTab === 'log'
                ? 'border-[#f8b932] text-[#f8b932]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab('log')}
          >
            Log Activity
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 ${
              activeTab === 'dashboard'
                ? 'border-[#f8b932] text-[#f8b932]'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto p-6">
        {optionsLoading && (
          <div className="text-sm text-gray-500">Loading form options...</div>
        )}

        {optionsError && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm mb-4">
            {optionsError}
            <button
              className="ml-2 text-red-800 underline"
              onClick={loadFieldOptions}
            >
              Retry
            </button>
          </div>
        )}

        {!optionsLoading && user && activeTab === 'log' && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4">
              Log New Activity
            </h2>
            <ActivityForm
              user={user}
              activityTypeOptions={activityTypeOptions}
              referralTypeOptions={referralTypeOptions}
              grantOptions={grantOptions}
              onSuccess={handleActivitySuccess}
            />
          </div>
        )}

        {!optionsLoading && activeTab === 'dashboard' && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-base font-semibold text-gray-800 mb-4">
              Activity Dashboard
            </h2>
            <ActivityList refreshKey={refreshKey} />
          </div>
        )}
      </div>
    </main>
  );
}
