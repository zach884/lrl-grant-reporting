// lib/auth.ts — GHL iframe user context parser

import { GHLUser } from '@/types';

export function parseGHLContext(searchParams: URLSearchParams): GHLUser {
  return {
    locationId: searchParams.get('location_id') ?? '',
    userId: searchParams.get('user_id') ?? '',
    userEmail: searchParams.get('user_email') ?? '',
    userName: searchParams.get('user_name') ?? '',
    isAdmin: searchParams.get('user_role') === 'admin',
  };
}
