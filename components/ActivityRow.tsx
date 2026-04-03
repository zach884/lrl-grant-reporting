// components/ActivityRow.tsx — Single activity row with edit/delete actions

interface ActivityRowProps {
  activity: {
    id: string;
    activity_name: string;
    activity_type: string;
    activity_date: string;
    activity_owner: string;
    program__grant_association: string[];
    contact_name?: string;
  };
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function ActivityRow({ activity, onEdit, onDelete }: ActivityRowProps) {
  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50">
      <td className="px-3 py-2 text-sm">{activity.activity_name}</td>
      <td className="px-3 py-2 text-sm">{activity.activity_type}</td>
      <td className="px-3 py-2 text-sm">{activity.contact_name ?? ''}</td>
      <td className="px-3 py-2 text-sm">{activity.activity_date}</td>
      <td className="px-3 py-2 text-sm">
        {activity.program__grant_association?.join(', ')}
      </td>
      <td className="px-3 py-2 text-sm">{activity.activity_owner}</td>
      <td className="px-3 py-2 text-sm">
        <button
          onClick={() => onEdit(activity.id)}
          className="text-blue-600 hover:text-blue-800 text-xs mr-2"
        >
          Edit
        </button>
        <button
          onClick={() => onDelete(activity.id)}
          className="text-red-600 hover:text-red-800 text-xs"
        >
          Delete
        </button>
      </td>
    </tr>
  );
}
