// lib/square/index.ts — public surface of the Square data-access layer.
export * from './config';
export { SquareClient, SquareApiError, square, resetDefaultSquareClient } from './client';
export type { SquareRequestOptions } from './client';
export * from './netSales';
