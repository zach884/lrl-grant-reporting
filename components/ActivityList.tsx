// components/ActivityList.tsx — Dashboard table of logged activities
import { useState, useEffect } from 'react';
import ActivityRow from './ActivityRow';

interface Activity {
  id: string;
  activity_name: string;
  activity_type: string;
  activity_date: string;
  activity_owner: string;
  program__grant_association: string[];
  contact_name?: string;
}

interface ActivityListProps {
  refreshKey: number;
}

export default function ActivityList({ refreshKey }: ActivityListProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    loadActivities();
  }, [refreshKey]);

  async function loadActivities() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/activities/list');
      if (!res.ok) throw new Error('Failed to load activities');
      const data = await res.json();
      setActivities(data.activities ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (deleteConfirm !== id) {
      setDeleteConfirm(id);
      return;
    }

    try {
      const res = await fetch(`/api/activities/delete?id=${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete activity');
      setActivities((prev) => prev.filter((a) => a.id !== id));
      setDeleteConfirm(null);
    } catch (err: any) {
      setError(err.message);
    }
  }

  function handleEdit(id: string) {
    // TODO: Open edit form pre-populated with activity data
    alert('Edit functionality coming soon');
  }

  if (loading) {
    return <div className="text-sm text-gray-500 py-4">Loading activities...</div>;
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm">
        {error}
      </div>
    );
  }

  if (activities.length === 0) {
    return <div className="text-sm text-gray-500 py-4">No activities logged yet.</div>;
  }

  return (
    <div className="overflow-x-auto">
      {deleteConfirm && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-2 rounded-md text-sm mb-2">
          Click Delete again to confirm. This cannot be undone.
        </div>
      )}
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Name</th>
            <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Type</th>
            <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Contact</th>
            <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Date</th>
            <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Grant(s)</th>
            <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Logged By</th>
            <th className="px-3 py-2 text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody>
          {activities.map((a) => (
            <ActivityRow
              key={a.id}
              activity={a}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
