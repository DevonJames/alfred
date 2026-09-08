/**
 * Date search normalization for the memory graph UI.
 * Keep in sync with packages/memory/src/date-query.ts
 */
(() => {
  const MONTH_INDEX = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sept: 9,
    sep: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  };
  const MONTH_NAMES = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function ordinal(day) {
    const mod = day % 100;
    if (mod >= 11 && mod <= 13) return `${day}th`;
    switch (day % 10) {
      case 1:
        return `${day}st`;
      case 2:
        return `${day}nd`;
      case 3:
        return `${day}rd`;
      default:
        return `${day}th`;
    }
  }

  function parseDateQuery(raw) {
    const t = raw.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
    if (!t) return null;
    const monthToken = Object.keys(MONTH_INDEX).join("|");

    let m = t.match(
      new RegExp(`\\b(${monthToken})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, "i"),
    );
    if (m?.[1] && m[2]) {
      return {
        month: MONTH_INDEX[m[1].toLowerCase()],
        day: Number(m[2]),
        year: m[3] ? Number(m[3]) : null,
      };
    }

    m = t.match(
      new RegExp(
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthToken})(?:\\s+(\\d{4}))?\\b`,
        "i",
      ),
    );
    if (m?.[1] && m[2]) {
      return {
        day: Number(m[1]),
        month: MONTH_INDEX[m[2].toLowerCase()],
        year: m[3] ? Number(m[3]) : null,
      };
    }

    m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m?.[1] && m[2] && m[3]) {
      return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    }

    m = t.match(/^--(\d{1,2})-(\d{1,2})$/);
    if (m?.[1] && m[2]) {
      return { year: null, month: Number(m[1]), day: Number(m[2]) };
    }

    m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
    if (m?.[1] && m[2]) {
      let year = m[3] ? Number(m[3]) : null;
      if (year != null && year < 100) year += year >= 70 ? 1900 : 2000;
      return { month: Number(m[1]), day: Number(m[2]), year };
    }

    m = t.match(new RegExp(`^(${monthToken})$`, "i"));
    if (m?.[1]) {
      return { month: MONTH_INDEX[m[1].toLowerCase()], day: null, year: null };
    }

    m = t.match(/^(\d{1,2})$/);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 12) return { month: n, day: null, year: null };
    }

    return null;
  }

  function expandDateSearchForms(raw) {
    const t = raw.trim().toLowerCase();
    if (!t) return [];
    const parsed = parseDateQuery(t);
    const forms = new Set([t]);
    if (!parsed?.month) return [...forms];

    const month = parsed.month;
    const m = pad(month);
    const name = MONTH_NAMES[month - 1];
    const abbrev = name.slice(0, 3);
    forms.add(name);
    forms.add(abbrev);
    forms.add(m);
    forms.add(`-${m}-`);
    forms.add(`-${m}`);
    forms.add(`/${m}/`);
    forms.add(`/${m}`);
    forms.add(`--${m}`);

    if (parsed.day != null) {
      const day = parsed.day;
      const d = pad(day);
      forms.add(`${name} ${day}`);
      forms.add(`${name} ${d}`);
      forms.add(`${name} ${ordinal(day)}`);
      forms.add(`${day} ${name}`);
      forms.add(`${ordinal(day)} ${name}`);
      forms.add(`${day} of ${name}`);
      forms.add(`${m}-${d}`);
      forms.add(`${m}/${d}`);
      forms.add(`${month}/${day}`);
      forms.add(`--${m}-${d}`);
      forms.add(`birthday ${name} ${day}`);
      forms.add(`birthday --${m}-${d}`);
      if (parsed.year != null) {
        const y = parsed.year;
        forms.add(`${y}-${m}-${d}`);
        forms.add(`${name} ${day}, ${y}`);
        forms.add(`${name} ${ordinal(day)}, ${y}`);
        forms.add(`${m}/${d}/${y}`);
        forms.add(`${month}/${day}/${y}`);
        forms.add(`birthday ${y}-${m}-${d}`);
      }
    } else {
      forms.add(`birthday ${name}`);
      forms.add(`birthday --${m}`);
    }
    return [...forms].filter(Boolean);
  }

  function matchesDateHaystack(haystack, query) {
    const hay = String(haystack || "").toLowerCase();
    if (!hay.trim() || !String(query || "").trim()) return false;
    const forms = expandDateSearchForms(query);
    if (!forms.length) return false;
    const parsed = parseDateQuery(query);

    if (parsed?.month != null && parsed.day == null && parsed.year == null) {
      const m = pad(parsed.month);
      const name = MONTH_NAMES[parsed.month - 1];
      const abbrev = name.slice(0, 3);
      return (
        hay.includes(name) ||
        new RegExp(`(?:^|[^a-z])${abbrev}(?:[^a-z]|$)`, "i").test(hay) ||
        hay.includes(`-${m}-`) ||
        hay.includes(`--${m}`) ||
        hay.includes(`/${m}/`) ||
        hay.includes(`/${m}`) ||
        new RegExp(`(?:^|[^0-9])${m}(?:[^0-9]|$)`).test(hay)
      );
    }

    if (parsed?.month != null && parsed.day != null) {
      const m = pad(parsed.month);
      const d = pad(parsed.day);
      const name = MONTH_NAMES[parsed.month - 1];
      const hasMonth =
        hay.includes(name) ||
        hay.includes(`-${m}-`) ||
        hay.includes(`--${m}`) ||
        hay.includes(`/${m}`);
      const hasDay =
        hay.includes(` ${parsed.day}`) ||
        hay.includes(`-${d}`) ||
        hay.includes(`/${d}`) ||
        hay.includes(`${ordinal(parsed.day)}`) ||
        hay.includes(` ${d}`) ||
        forms.some((f) => f.includes(`${m}-${d}`) && hay.includes(f));
      if (hasMonth && hasDay) return true;
      return forms.some((f) => f.length >= 4 && hay.includes(f));
    }

    return forms.some((f) => hay.includes(f));
  }

  window.AlfredDateQuery = {
    parseDateQuery,
    expandDateSearchForms,
    matchesDateHaystack,
  };
})();
