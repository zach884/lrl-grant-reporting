// components/ContactSearch.tsx — Searchable contact dropdown with debounced GHL search
import { useState, useEffect, useRef } from 'react';
import type { ContactOption } from '@/types';

interface ContactSearchProps {
  label: string;
  value: ContactOption | null;
  onChange: (contact: ContactOption | null) => void;
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
    setQuery(contact.display);
    setIsOpen(false);
  }

  function handleClear() {
    onChange(null);
    setQuery('');
    setResults([]);
  }

  return (
    <div ref={wrapperRef} className="relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          type="text"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="Search by name, company, or email..."
          value={value ? value.display : query}
          onChange={(e) => {
            if (value) onChange(null);
            setQuery(e.target.value);
          }}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true);
          }}
        />
        {value && (
          <button
            type="button"
            onClick={handleClear}
            className="px-2 text-gray-400 hover:text-gray-600"
          >
            x
          </button>
        )}
      </div>

      {loading && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg p-2 text-sm text-gray-500">
          Searching...
        </div>
      )}

      {isOpen && !loading && results.length > 0 && (
        <ul className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
          {results.map((c) => (
            <li
              key={c.id}
              className="px-3 py-2 hover:bg-blue-50 cursor-pointer text-sm"
              onClick={() => handleSelect(c)}
            >
              <div className="font-medium">
                {c.company_name && c.full_name
                  ? `${c.company_name} — ${c.full_name}`
                  : c.display}
              </div>
              <div className="text-gray-500 text-xs">
                {c.email}{c.city ? ` — ${c.city}, ${c.state}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}

      {isOpen && !loading && results.length === 0 && query.length >= 2 && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg p-2 text-sm text-gray-500">
          No contacts found
        </div>
      )}
    </div>
  );
}
