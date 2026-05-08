// ─────────────────────────────────────────────────────────────────────────────
// Timezone helpers — map a raw phone number to an IANA timezone, and enforce
// quiet hours on outbound automation so we don't nudge customers at 2am.
//
// Policy: the MINIMUM set of country-code mappings that actually covers
// Oiikon's customer base (Cuba + US + the Cuban diaspora — Spain, Mexico,
// Venezuela, Argentina, Colombia). Adding more is cheap when we see traffic.
// Anything we don't know falls back to America/New_York, which is correct
// for Miami ops and close enough for Cuba (both UTC-5 standard / UTC-4 DST).
// ─────────────────────────────────────────────────────────────────────────────

interface CountryTzRule {
  /** Digits-only prefix (E.164 without +). Match longest-first. */
  prefix: string;
  tz: string;
}

// Ordered most-specific first so +1242 (Bahamas) wins over +1 (US/Canada).
const COUNTRY_TZ_RULES: CountryTzRule[] = [
  // Caribbean non-US that share +1
  { prefix: '1242', tz: 'America/Nassau' },     // Bahamas
  { prefix: '1787', tz: 'America/Puerto_Rico' }, // Puerto Rico
  { prefix: '1939', tz: 'America/Puerto_Rico' },
  { prefix: '1809', tz: 'America/Santo_Domingo' }, // DR
  { prefix: '1829', tz: 'America/Santo_Domingo' },
  { prefix: '1849', tz: 'America/Santo_Domingo' },

  // Cuban diaspora markets
  { prefix: '53', tz: 'America/Havana' },    // Cuba
  { prefix: '34', tz: 'Europe/Madrid' },     // Spain
  { prefix: '52', tz: 'America/Mexico_City' }, // Mexico
  { prefix: '58', tz: 'America/Caracas' },   // Venezuela
  { prefix: '54', tz: 'America/Argentina/Buenos_Aires' },
  { prefix: '57', tz: 'America/Bogota' },    // Colombia
  { prefix: '51', tz: 'America/Lima' },      // Peru
  { prefix: '56', tz: 'America/Santiago' },  // Chile
  { prefix: '506', tz: 'America/Costa_Rica' },
  { prefix: '502', tz: 'America/Guatemala' },
  { prefix: '503', tz: 'America/El_Salvador' },
  { prefix: '504', tz: 'America/Tegucigalpa' }, // Honduras
  { prefix: '505', tz: 'America/Managua' },     // Nicaragua

  // Default for +1 (USA/Canada) — we bias Miami since that's the operator
  // side of the business. Not perfect for Californian diaspora but cheap.
  { prefix: '1', tz: 'America/New_York' },
];

const DEFAULT_TZ = 'America/New_York';

/**
 * Resolve an IANA timezone from a raw phone number. Accepts +, spaces,
 * hyphens, parens — strips them all and matches the longest country-code
 * prefix from our rule table. Returns DEFAULT_TZ if nothing matches.
 *
 * Exported for unit testing AND for the webhook's turn-1 seed path.
 */
export function timezoneFromPhone(rawPhone: string): string {
  const digits = (rawPhone ?? '').replace(/\D/g, '');
  if (!digits) return DEFAULT_TZ;

  // Longest-first match (rules are already ordered that way; iterate linearly)
  for (const rule of COUNTRY_TZ_RULES) {
    if (digits.startsWith(rule.prefix)) return rule.tz;
  }
  return DEFAULT_TZ;
}

/**
 * Quiet-hours policy: no outbound automation between 21:00 and 08:00 LOCAL
 * to the customer. The window is inclusive of 21:00 and exclusive of 08:00
 * (so 07:59 is still quiet, 08:00 is open).
 *
 * Why these bounds: WhatsApp Business policy discourages after-hours sends;
 * dinner (21:00+) and early morning (before 08:00) are the two windows
 * where a sales nudge reads as intrusive. Keeping them tight (9am–9pm is
 * open) lets us still catch ~13 hours per day.
 */
const QUIET_START_HOUR = 21;
const QUIET_END_HOUR = 8;

export interface QuietHoursVerdict {
  /** True when right-now is inside the customer's local quiet window. */
  isQuiet: boolean;
  /** The hour (0-23) in the customer's local time used for the check. */
  localHour: number;
  /** The timezone actually applied. */
  timezone: string;
}

/**
 * Check whether the current moment (or the provided `now`) falls inside
 * quiet hours for the given timezone. Callers pass the customer's stored
 * `user_timezone` (falling back to their phone-derived tz, then to
 * DEFAULT_TZ).
 *
 * Uses Intl.DateTimeFormat rather than manual offset math so DST is
 * handled correctly. Any invalid tz silently coerces to DEFAULT_TZ.
 */
export function isInQuietHours(
  timezone: string | null | undefined,
  now: Date = new Date()
): QuietHoursVerdict {
  const tz = timezone && timezone.length > 0 ? timezone : DEFAULT_TZ;
  let localHour = 0;
  let usedTz = tz;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    });
    // `hour` in 24h can render as "24" at midnight in some locales; mod it.
    const raw = formatter.format(now);
    localHour = Number(raw) % 24;
    if (!Number.isFinite(localHour)) throw new Error('NaN hour');
  } catch {
    // Bad tz string — fall back to default. Warn so the bad data bubbles up.
    console.warn(`[timezone] invalid tz "${tz}", falling back to ${DEFAULT_TZ}`);
    usedTz = DEFAULT_TZ;
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TZ,
      hour: '2-digit',
      hour12: false,
    });
    localHour = Number(formatter.format(now)) % 24;
  }

  // 21 ≤ hour  OR  hour < 8  → quiet
  const isQuiet = localHour >= QUIET_START_HOUR || localHour < QUIET_END_HOUR;
  return { isQuiet, localHour, timezone: usedTz };
}

/**
 * Convenience for tests: expose the quiet-hour bounds so tests can assert
 * against them without hard-coding.
 */
export const QUIET_HOURS = { start: QUIET_START_HOUR, end: QUIET_END_HOUR };
