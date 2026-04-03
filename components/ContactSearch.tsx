// components/ContactSearch.tsx — Searchable contact dropdown with debounced GHL search
import { useState, useEffect, useRef } from 'react';
import type { ContactOption } from '@/types';

interface ContactSearchProps {
  label: string;
  value: ContactOption | null;
  onChange: (contact: ContactOption | null) => void;
}

function contactDisplayText(c: ContactOption): string {
  if (c.company_name && c.full_name) return `${c.full_name} — ${c.company_name}`;
  return c.full_name || c.company_name || c.email || 'Unknown';
}

export default function ContactSearch({ label, value, onChange }: ContactSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactOption[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setResults(data.contacts ?? []);
        setIsOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  function handleSelect(contact: ContactOption) {
    onChange(contact);
    setQuery('');
    setIsOpen(false);
  }

  function handleClear() {
    onChange(null);
    setQuery('');
    setResults([]);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-black mb-1">{label}</label>

      {/* Selected contact chip */}
      {value ? (
        <div className="flex items-center justify-between border border-gray-300 rounded-md px-3 py-2 bg-gray-50">
          <div>
            <div className="text-sm font-medium text-black">{value.full_name || value.display}</div>
            {value.company_name && (
              <div className="text-xs text-gray-600">{value.company_name}</div>
            )}
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="ml-2 text-gray-400 hover:text-gray-700 text-lg leading-none"
          >
            &times;
          </button>
        </div>
      ) : (
        <input
          type="text"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-[#f8b932] focus:border-[#f8b932]"
          placeholder="Search by name, company, or email..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true);
          }}
        />
      )}

      {loading && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg p-2 text-sm text-gray-600">
          Searching...
        </div>
      )}

      {isOpen && !loading && results.length > 0 && (
        <ul className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
          {results.map((c) => (
            <li
              key={c.id}
              className="px-3 py-2 hover:bg-[#f8b932]/10 cursor-pointer text-sm"
              onClick={() => handleSelect(c)}
            >
              <div className="font-medium text-black">{contactDisplayText(c)}</div>
              <div className="text-gray-600 text-xs">
                {c.email}{c.city ? ` — ${c.city}, ${c.state}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}

      {isOpen && !loading && results.length === 0 && query.length >= 2 && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg p-2 text-sm text-gray-600">
          No contacts found
        </div>
      )}
    </div>
  );
}
