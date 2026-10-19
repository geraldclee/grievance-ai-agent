// Grievance Policy rules: routing ladder, deadlines and business-hour maths.

export const LADDER = [
  { key: 'team_lead', name: 'Team Lead', days: 7 },
  { key: 'department_lead', name: 'Department Lead', days: 14 },
  { key: 'people_ops', name: 'People Ops', days: 21 },
];

export const INFORMAL_CONTACTS = {
  team_lead: 'Team Lead',
  people_ops: 'People Ops',
  designated: 'Designated contact (via People Ops)',
};

// Who reviews a formal grievance first.
export function startLevel(about) {
  if (about === 'team_lead') return 1;       // grievance concerns the Team Lead -> Department Lead
  if (about === 'department_lead') return 2; // concerns the Department Lead -> People Ops
  return 0;                                   // otherwise -> Team Lead
}

const HOUR = 3600000;
const DAY_START = 9;
const DAY_END = 18;

// All calculations run in the company's local time (TZ_OFFSET_HOURS, default +8 Singapore).
function toLocal(d, tz) { return new Date(d.getTime() + tz * HOUR); }
function fromLocal(d, tz) { return new Date(d.getTime() - tz * HOUR); }
const isWeekend = d => d.getUTCDay() === 0 || d.getUTCDay() === 6;

export function addBusinessHours(date, hours, tz = 8) {
  let t = toLocal(date, tz);
  let mins = hours * 60;
  while (mins > 0) {
    const h = t.getUTCHours() + t.getUTCMinutes() / 60;
    if (isWeekend(t) || h >= DAY_END) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(DAY_START, 0, 0, 0);
      continue;
    }
    if (h < DAY_START) { t.setUTCHours(DAY_START, 0, 0, 0); continue; }
    const end = new Date(t); end.setUTCHours(DAY_END, 0, 0, 0);
    const use = Math.min((end - t) / 60000, mins);
    t = new Date(t.getTime() + use * 60000);
    mins -= use;
  }
  return fromLocal(t, tz);
}

export function addBusinessDays(date, n, tz = 8) {
  const t = toLocal(date, tz);
  while (n > 0) {
    t.setUTCDate(t.getUTCDate() + 1);
    if (!isWeekend(t)) n--;
  }
  return fromLocal(t, tz);
}

export function addDays(date, n) {
  return new Date(date.getTime() + n * 24 * HOUR);
}
