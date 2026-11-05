// 值班时间与查询窗口：什么时候该查、查哪一段。
// 节假日来自公开接口，一年拉一次存本地；窗口记在 cursor 文件里，所以周末、合盖、漏跑都不会漏掉改动。
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type Calendar = { [year: string]: { [date: string]: { is_holiday: number; week: number; name?: string } } };

const HOLIDAY_API = "https://holiday.ailcc.com/api/holiday/allyear";

/** The date and time in the zone the rules use, as plain parts. */
export function clockOf(at: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (kind: string) => parts.find((p) => p.type === kind)?.value ?? "";
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    date: `${part("year")}-${part("month")}-${part("day")}`,
  };
}

/**
 * Whether the day is a working day. The calendar already accounts for the make-up workdays
 * that fall on a weekend, so a day off is the one the calendar marks as a holiday.
 */
export function isWorkingDay(calendar: Calendar, date: string) {
  const day = calendar[date.slice(0, 4)]?.[date];
  if (!day) return true; // No calendar for that year: every weekday counts.
  return day.is_holiday === 0;
}

/** The year's days, from the local file when it is there and from the public API when it is not. */
export async function loadYear(
  year: string,
  file: string,
  url: string = HOLIDAY_API,
  fetchNow: typeof fetch = fetch,
): Promise<Calendar> {
  let calendar: Calendar = {};
  if (existsSync(file)) {
    try {
      calendar = JSON.parse(readFileSync(file, "utf8")) as Calendar;
    } catch {
      calendar = {};
    }
  }
  if (calendar[year]) return calendar;
  const response = await fetchNow(`${url}/${year}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`节假日接口返回 ${response.status}`);
  const body = (await response.json()) as {
    code: number;
    data?: { date: string; is_holiday: number; week: number; name?: string }[];
  };
  if (body.code !== 0 || !body.data) throw new Error("节假日接口没有交回数据");
  const days: Calendar[string] = {};
  for (const day of body.data) days[day.date] = { is_holiday: day.is_holiday, week: day.week, name: day.name };
  calendar[year] = days;
  writeFileSync(file, `${JSON.stringify(calendar, null, 2)}\n`);
  return calendar;
}

/** Where the last run stopped, so this one picks up where it left off. */
export function readCursor(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const cursor = JSON.parse(readFileSync(file, "utf8")) as { lastCheckedAt?: string };
    return cursor.lastCheckedAt ?? null;
  } catch {
    return null;
  }
}

export function writeCursor(file: string, at: string) {
  writeFileSync(file, `${JSON.stringify({ lastCheckedAt: at })}\n`);
}

/** The moment the last run reached, in the form Jira's query takes. */
export function windowStart(lastCheckedAt: string | null, now: Date, zone: string, firstRunAt: string) {
  if (!lastCheckedAt) return firstRunAt;
  const at = new Date(lastCheckedAt);
  if (Number.isNaN(at.getTime())) return firstRunAt;
  // Jira takes "YYYY-MM-DD HH:mm" in the project's own time.
  const clock = clockOf(at, zone);
  return `${clock.date} ${clock.hour}:${clock.minute}`;
}
