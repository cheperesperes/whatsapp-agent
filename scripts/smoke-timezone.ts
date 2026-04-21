/**
 * Smoke test for the timezone helpers.
 * Covers:
 *   • timezoneFromPhone — longest-first prefix matching, garbage-input
 *     fallback, the Cuban diaspora markets we actually support.
 *   • isInQuietHours — 21:00 is the first quiet hour, 08:00 is the first
 *     open hour; bogus tz string coerces to America/New_York.
 *
 * Run from repo root: npx tsx scripts/smoke-timezone.ts
 * Exits 0 on success, 1 on any failure.
 */
import { isInQuietHours, QUIET_HOURS, timezoneFromPhone } from '../lib/timezone';

let passes = 0;
let fails = 0;

function green(s: string) {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string) {
  return `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string) {
  return `\x1b[2m${s}\x1b[0m`;
}

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(green('  PASS') + ' ' + name);
    passes += 1;
    return;
  }
  console.log(red('  FAIL') + ' ' + name);
  console.log(dim('    want: ' + JSON.stringify(want)));
  console.log(dim('    got:  ' + JSON.stringify(got)));
  fails += 1;
}

function checkTrue(name: string, got: boolean) {
  check(name, got, true);
}

// ────────────────────────────────────────────────────────────
// timezoneFromPhone
// ────────────────────────────────────────────────────────────

console.log('timezoneFromPhone:');

// Core markets — all the ones the rule table enumerates explicitly.
// Note: timezoneFromPhone requires the E.164 country code prefix. A bare
// 10-digit US number (5617024893) is ambiguous against +56 (Chile) and by
// design matches Chile's prefix — WhatsApp always sends E.164, so this is
// fine in production.
check('+1 555 bare US → America/New_York', timezoneFromPhone('+15555551234'), 'America/New_York');
check('11-digit US with leading 1 → America/New_York', timezoneFromPhone('15617024893'), 'America/New_York');
check('+53 Cuba → America/Havana', timezoneFromPhone('+5355512345'), 'America/Havana');
check('raw 53 Cuba → America/Havana', timezoneFromPhone('5355512345'), 'America/Havana');
check('+34 Spain → Europe/Madrid', timezoneFromPhone('+34612345678'), 'Europe/Madrid');
check('+52 Mexico → America/Mexico_City', timezoneFromPhone('+525512345678'), 'America/Mexico_City');
check('+58 Venezuela → America/Caracas', timezoneFromPhone('+582121234567'), 'America/Caracas');
check('+54 Argentina → Buenos_Aires', timezoneFromPhone('+5491112345678'), 'America/Argentina/Buenos_Aires');
check('+57 Colombia → America/Bogota', timezoneFromPhone('+573001234567'), 'America/Bogota');
check('+51 Peru → America/Lima', timezoneFromPhone('+5119876543'), 'America/Lima');
check('+56 Chile → America/Santiago', timezoneFromPhone('+56912345678'), 'America/Santiago');
check('+506 Costa Rica → America/Costa_Rica', timezoneFromPhone('+50688887777'), 'America/Costa_Rica');
check('+502 Guatemala → America/Guatemala', timezoneFromPhone('+50255551234'), 'America/Guatemala');
check('+503 El Salvador → America/El_Salvador', timezoneFromPhone('+50377771234'), 'America/El_Salvador');
check('+504 Honduras → America/Tegucigalpa', timezoneFromPhone('+50499991234'), 'America/Tegucigalpa');
check('+505 Nicaragua → America/Managua', timezoneFromPhone('+50588881234'), 'America/Managua');

// Longest-first: +1242 (Bahamas) must beat +1 (US)
check('+1242 Bahamas longest-first', timezoneFromPhone('+12425551234'), 'America/Nassau');
check('+1787 Puerto Rico longest-first', timezoneFromPhone('+17875551234'), 'America/Puerto_Rico');
check('+1939 Puerto Rico alt longest-first', timezoneFromPhone('+19395551234'), 'America/Puerto_Rico');
check('+1809 DR longest-first', timezoneFromPhone('+18095551234'), 'America/Santo_Domingo');
check('+1829 DR longest-first', timezoneFromPhone('+18295551234'), 'America/Santo_Domingo');
check('+1849 DR longest-first', timezoneFromPhone('+18495551234'), 'America/Santo_Domingo');

// Format tolerance — spaces, dashes, parens, stray chars
check(
  'formatted +1 (561) 702-4893 → America/New_York',
  timezoneFromPhone('+1 (561) 702-4893'),
  'America/New_York'
);
check(
  '"whatsapp: +53 555 1234" → America/Havana (non-digits stripped)',
  timezoneFromPhone('whatsapp: +53 555 1234'),
  'America/Havana'
);

// Unknown prefix → default
check('unknown +999 → default NY', timezoneFromPhone('+9991234567'), 'America/New_York');
check('empty string → default NY', timezoneFromPhone(''), 'America/New_York');
check('null-ish → default NY', timezoneFromPhone(null as unknown as string), 'America/New_York');
check('all punctuation → default NY', timezoneFromPhone('+++()---'), 'America/New_York');

// ────────────────────────────────────────────────────────────
// isInQuietHours — QUIET_HOURS constant is { start: 21, end: 8 }
// ────────────────────────────────────────────────────────────

console.log('\nQUIET_HOURS constant:');
check('QUIET_HOURS.start === 21', QUIET_HOURS.start, 21);
check('QUIET_HOURS.end === 8', QUIET_HOURS.end, 8);

console.log('\nisInQuietHours (America/New_York, mocked times):');

// Helper: build a UTC Date that represents a specific local hour in NY.
// We pick Apr 21 2026 (a Tuesday in DST, UTC-4) so: local 20:59 NY = 00:59 UTC of next day.
// To avoid hand-rolling offsets we instead pick times in a fixed-offset tz with no DST:
// `America/Phoenix` is UTC-7 year round. Use that for deterministic assertions.
//
// For America/New_York, use Intl-powered round-trip: format a UTC Date under NY,
// compare the advertised hour.

// Anchor dates around a known DST-stable winter moment (UTC-5 for NY).
// January 15, 2026 12:00 UTC = 07:00 NY
const winterNoonUtc = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));

const r0700NY = isInQuietHours('America/New_York', winterNoonUtc);
check('07:00 NY (quiet: hour<8)', r0700NY, { isQuiet: true, localHour: 7, timezone: 'America/New_York' });

const r0800NY = isInQuietHours('America/New_York', new Date(Date.UTC(2026, 0, 15, 13, 0, 0)));
check('08:00 NY (open: hour==8)', r0800NY, { isQuiet: false, localHour: 8, timezone: 'America/New_York' });

const r2059NY = isInQuietHours('America/New_York', new Date(Date.UTC(2026, 0, 16, 1, 59, 0)));
check('20:59 NY (open: hour<21)', r2059NY, { isQuiet: false, localHour: 20, timezone: 'America/New_York' });

const r2100NY = isInQuietHours('America/New_York', new Date(Date.UTC(2026, 0, 16, 2, 0, 0)));
check('21:00 NY (quiet: hour==21)', r2100NY, { isQuiet: true, localHour: 21, timezone: 'America/New_York' });

const r1200NY = isInQuietHours('America/New_York', new Date(Date.UTC(2026, 0, 15, 17, 0, 0)));
check('12:00 NY (open: noon)', r1200NY, { isQuiet: false, localHour: 12, timezone: 'America/New_York' });

// Havana matches NY offset in winter too (no DST in Cuba).
const r2100Havana = isInQuietHours('America/Havana', new Date(Date.UTC(2026, 0, 16, 2, 0, 0)));
check('21:00 Havana (quiet)', r2100Havana, { isQuiet: true, localHour: 21, timezone: 'America/Havana' });

// Edge: DST transition safety — April in NY is UTC-4 so 12 UTC = 08 local.
const aprilDstMorning = new Date(Date.UTC(2026, 3, 15, 12, 0, 0));
const rDstNY = isInQuietHours('America/New_York', aprilDstMorning);
check(
  '12:00 UTC = 08:00 NY in April DST (open)',
  rDstNY,
  { isQuiet: false, localHour: 8, timezone: 'America/New_York' }
);

// Null / empty tz → falls back to America/New_York default
const rNullTz = isInQuietHours(null, winterNoonUtc);
check(
  'null tz → coerced to America/New_York',
  rNullTz,
  { isQuiet: true, localHour: 7, timezone: 'America/New_York' }
);

const rEmptyTz = isInQuietHours('', winterNoonUtc);
check(
  'empty tz → coerced to America/New_York',
  rEmptyTz,
  { isQuiet: true, localHour: 7, timezone: 'America/New_York' }
);

// Bogus tz string → caught, falls back to NY silently (with a console.warn).
const rBogus = isInQuietHours('Not/A_Real_Zone', winterNoonUtc);
checkTrue('bogus tz: result is America/New_York', rBogus.timezone === 'America/New_York');
checkTrue('bogus tz: flag reflects NY hour', rBogus.localHour === 7 && rBogus.isQuiet === true);

// Mid-morning in Madrid during NY quiet hours — the point of per-customer tz.
// Jan 15 2026 12:00 UTC = 13:00 Madrid (winter, UTC+1)
const rMadrid = isInQuietHours('Europe/Madrid', winterNoonUtc);
check(
  '12:00 UTC = 13:00 Madrid (open) — proves per-customer tz is honored',
  rMadrid,
  { isQuiet: false, localHour: 13, timezone: 'Europe/Madrid' }
);

// ────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────

console.log();
if (fails === 0) {
  console.log(green(`${passes}/${passes} smoke tests passed.`));
  process.exit(0);
} else {
  console.log(red(`${passes} passed, ${fails} FAILED.`));
  process.exit(1);
}
