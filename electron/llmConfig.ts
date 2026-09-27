/** Only a finite non-negative number survives; anything else (string, NaN, negative, missing) is dropped. */
export function validPrice(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}
