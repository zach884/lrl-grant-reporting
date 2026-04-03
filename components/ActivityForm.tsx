// components/ActivityForm.tsx — Main activity logging form
import { useState, useEffect, useMemo } from 'react';
import ContactSearch from './ContactSearch';
import type { ContactOption, FieldOption, GHLUser } from '@/types';

interface ActivityFormProps {
  user: GHLUser;
  activityTypeOptions: FieldOption[];
  referralTypeOptions: FieldOption[];
  grantOptions: FieldOption[];
  onSuccess?: () => void;
}

export default function ActivityForm({
  user,
  activityTypeOptions,
  referralTypeOptions,
  grantOptions,
  onSuccess,
}: ActivityFormProps) {
  const [contact, setContact] = useState<ContactOption | null>(null);
  const [activityType, setActivityType] = useState('');
  const [activityDate, setActivityDate] = useState(
    new Date().toISOString().split('T')[0]
  );
  const [selectedGrants, setSelectedGrants] = useState<string[]>([]);
  const [activityNotes, setActivityNotes] = useState('');
  const [referredTo, setReferredTo] = useState<ContactOption | null>(null);
  const [referralType, setReferralType] = useState('');
  const [nameOverride, setNameOverride] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [sheetWarning, setSheetWarning] = useState('');

  const isReferral = activityType === 'referral';

  // Auto-generate activity name
  const generatedName = useMemo(() => {
    const entity = contact?.company_name || contact?.full_name || '';
    const typeLabel =
      activityTypeOptions.find((o) => o.key === activityType)?.label || '';
    const dateStr = activityDate
      ? new Date(activityDate + 'T00:00:00').toLocaleDateString('en-US')
      : '';
    if (!entity || !typeLabel || !dateStr) return '';
    return `${typeLabel} – ${entity} – ${dateStr}`;
  }, [contact, activityType, activityDate, activityTypeOptions]);

  const activityName = isEditingName ? nameOverride : generatedName;

  function handleGrantToggle(grantKey: string) {
    setSelectedGrants((prev) =>
      prev.includes(grantKey)
        ? prev.filter((g) => g !== grantKey)
        : [...prev, grantKey]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');
    setSheetWarning('');

    // Validate
    if (!contact) return setErrorMsg('Please select a contact.');
    if (!activityType) return setErrorMsg('Please select an activity type.');
    if (!activityDate) return setErrorMsg('Please select a date.');
    if (selectedGrants.length === 0) return setErrorMsg('Please select at least one grant.');
    if (isReferral && !referredTo)
      return setErrorMsg('Please select a referred-to contact.');
    if (isReferral && !referralType)
      return setErrorMsg('Please select a referral type.');

    setSubmitting(true);

    try {
      // Create activity in GHL
      const actRes = await fetch('/api/activities/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contact.id,
          activity_name: activityName,
          activity_date: activityDate,
          activity_type: activityType,
          activity_notes: activityNotes,
          activity_owner: user.userName,
          program__grant_association: selectedGrants,
          referral_type: isReferral ? referralType : '',
          referred_to_id: isReferral ? referredTo?.id : undefined,
        }),
      });

      if (!actRes.ok) {
        const err = await actRes.json();
        throw new Error(err.error || 'Failed to create activity');
      }

      const actData = await actRes.json();

      // Trigger sheet append (non-blocking for enrichment)
      try {
        const sheetRes = await fetch('/api/sheets/append', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contact_id: contact.id,
            activity_name: activityName,
            activity_date: activityDate,
            activity_type: activityType,
            activity_notes: activityNotes,
            activity_owner: user.userName,
            program__grant_association: selectedGrants,
            referral_type: isReferral ? referralType : '',
            referred_to_id: isReferral ? referredTo?.id : undefined,
          }),
        });

        if (!sheetRes.ok) {
          setSheetWarning('Activity saved to GHL but sheet write failed. You can retry from the dashboard.');
        }
      } catch {
        setSheetWarning('Activity saved to GHL but sheet write failed. You can retry from the dashboard.');
      }

      setSuccessMsg(`Activity created: ${activityName}`);

      // Reset form but keep contact pre-filled
      setActivityType('');
      setActivityDate(new Date().toISOString().split('T')[0]);
      setSelectedGrants([]);
      setActivityNotes('');
      setReferredTo(null);
      setReferralType('');
      setNameOverride('');
      setIsEditingName(false);

      onSuccess?.();
    } catch (err: any) {
      setErrorMsg(err.message || 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Contact */}
      <ContactSearch label="Contact *" value={contact} onChange={setContact} />

      {/* Activity Type */}
      <div>
        <label className="block text-sm font-medium text-black mb-1">
          Activity Type *
        </label>
        <select
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-[#f8b932] focus:border-[#f8b932]"
          value={activityType}
          onChange={(e) => setActivityType(e.target.value)}
        >
          <option value="">Select activity type...</option>
          {activityTypeOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Referral fields — shown directly under Activity Type when referral is selected */}
      {isReferral && (
        <div className="space-y-4 pl-4 border-l-2 border-[#f8b932]">
          <ContactSearch
            label="Referred To *"
            value={referredTo}
            onChange={setReferredTo}
          />

          <div>
            <label className="block text-sm font-medium text-black mb-1">
              Referral Type *
            </label>
            <select
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-[#f8b932] focus:border-[#f8b932]"
              value={referralType}
              onChange={(e) => setReferralType(e.target.value)}
            >
              <option value="">Select referral type...</option>
              {referralTypeOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Activity Date */}
      <div>
        <label className="block text-sm font-medium text-black mb-1">
          Activity Date *
        </label>
        <input
          type="date"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-[#f8b932] focus:border-[#f8b932]"
          value={activityDate}
          onChange={(e) => setActivityDate(e.target.value)}
        />
      </div>

      {/* Grant / Program */}
      <div>
        <label className="block text-sm font-medium text-black mb-1">
          Grant / Program *
        </label>
        <div className="space-y-1">
          {grantOptions.map((g) => (
            <label key={g.key} className="flex items-center gap-2 text-sm text-black">
              <input
                type="checkbox"
                checked={selectedGrants.includes(g.key)}
                onChange={() => handleGrantToggle(g.key)}
                className="rounded border-gray-300 text-[#f8b932] focus:ring-[#f8b932]"
              />
              {g.label}
            </label>
          ))}
        </div>
      </div>

      {/* Activity Name (auto-generated) */}
      <div>
        <label className="block text-sm font-medium text-black mb-1">
          Activity Name
        </label>
        {isEditingName ? (
          <input
            type="text"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-[#f8b932] focus:border-[#f8b932]"
            value={nameOverride}
            onChange={(e) => setNameOverride(e.target.value)}
          />
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-gray-50 border border-gray-200 rounded-md px-3 py-2 text-sm text-black">
              {generatedName || 'Will auto-generate as you fill in fields...'}
            </div>
            <button
              type="button"
              className="text-xs text-[#f8b932] hover:text-[#e0a020] font-medium"
              onClick={() => {
                setNameOverride(generatedName);
                setIsEditingName(true);
              }}
            >
              Edit
            </button>
          </div>
        )}
      </div>

      {/* Activity Notes */}
      <div>
        <label className="block text-sm font-medium text-black mb-1">
          Activity Notes
        </label>
        <textarea
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-[#f8b932] focus:border-[#f8b932]"
          rows={3}
          value={activityNotes}
          onChange={(e) => setActivityNotes(e.target.value)}
          placeholder="Optional notes..."
        />
      </div>

      {/* Messages */}
      {errorMsg && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-md text-sm">
          {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded-md text-sm">
          {successMsg}
        </div>
      )}
      {sheetWarning && (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 px-3 py-2 rounded-md text-sm">
          {sheetWarning}
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={submitting}
        className="w-full bg-[#f8b932] text-black py-2 px-4 rounded-md text-sm font-medium hover:bg-[#e0a020] disabled:bg-[#f8b932]/50 disabled:cursor-not-allowed"
      >
        {submitting ? 'Saving...' : 'Log Activity'}
      </button>
    </form>
  );
}
