/**
 * أسابيع العمل: من الأحد إلى الخميس (الجمعة والسبت محظوران للإجازة).
 * ربط الأسابيع 1–4 بالشهر: الأسبوع الأول يبدأ من أحد معيّن حسب قواعد الشهر.
 */

function pad2(n) {
    return String(n).padStart(2, '0');
}

function fmtLocalDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** أول أحد يُعتبر بداية «الأسبوع الأول» للشهر */
function getMonthWeek1Sunday(year, monthNumber) {
    const first = new Date(year, monthNumber - 1, 1);
    const dow = first.getDay(); // 0=أحد
    if (dow === 0) return new Date(year, monthNumber - 1, 1);
    if (dow === 1) return new Date(year, monthNumber - 1, 0); // اليوم 0 = آخر يوم من الشهر السابق → أحد يسبق الاثنين
    if (dow >= 2 && dow <= 4) return new Date(year, monthNumber - 1, 1 + (7 - dow));
    return new Date(year, monthNumber - 1, 1 + (7 - dow)); // جمعة / سبت
}

/** كل أسباع (أحد–خميس) التي تقطع أي يوم من أيام الشهر الميلادي monthNumber */
function listIntersectingWorkWeeks(year, monthNumber) {
    const monthEnd = new Date(year, monthNumber, 0);
    const seen = new Map();
    for (let dom = 1; dom <= monthEnd.getDate(); dom++) {
        const d = new Date(year, monthNumber - 1, dom);
        const day = d.getDay();
        if (day === 5 || day === 6) continue;
        const sun = new Date(d);
        sun.setDate(d.getDate() - day);
        const thu = new Date(sun);
        thu.setDate(sun.getDate() + 4);
        const key = fmtLocalDate(sun);
        if (!seen.has(key)) {
            seen.set(key, { start_date: fmtLocalDate(sun), end_date: fmtLocalDate(thu) });
        }
    }
    return Array.from(seen.values()).sort((a, b) => a.start_date.localeCompare(b.start_date));
}

/**
 * المصفوفة المضغوطة لأربعة مواضع: إن وُجد أكثر من 4 أسابيع متقاطعة مع الشهر،
 * نأخذ أول أسبوعين + آخر أسبوعين لتغطية آخر أسبوع يمتد للشهر التالي (مثل 28 آذار–1 نيسان).
 */
function compactFourSlots(year, monthNumber) {
    const weeks = listIntersectingWorkWeeks(year, monthNumber);
    if (weeks.length <= 4) return weeks;
    return [weeks[0], weeks[1], weeks[weeks.length - 2], weeks[weeks.length - 1]];
}

/** الأسبوع (أحد–خميس) الذي يشمل اليوم 21 من الشهر — «فترة رواتب» للموضع الرابع */
function getWeek4PayrollWeek(year, monthNumber) {
    const d = new Date(year, monthNumber - 1, 21);
    const dow = d.getDay();
    const sun = new Date(year, monthNumber - 1, 21 - dow);
    const thu = new Date(sun);
    thu.setDate(sun.getDate() + 4);
    return { start_date: fmtLocalDate(sun), end_date: fmtLocalDate(thu), label: 'فترة رواتب' };
}

/** الأسابيع 1–3: تقاطع الشهر باستثناء أسبوع الرواتب إن تطابق مع أحدها */
function slotsForWeeks123(year, monthNumber) {
    const w4 = getWeek4PayrollWeek(year, monthNumber);
    const all = listIntersectingWorkWeeks(year, monthNumber);
    const filtered = all.filter(w => w.start_date !== w4.start_date);
    const out = [];
    for (let i = 0; i < 3; i++) {
        if (filtered[i]) out.push(filtered[i]);
        else if (all[i]) out.push(all[i]);
    }
    return out;
}

function getWeekAutoDates(year, monthNumber, weekNumber) {
    const wn = parseInt(weekNumber, 10);
    if (wn === 4) return getWeek4PayrollWeek(year, monthNumber);
    const first3 = slotsForWeeks123(year, monthNumber);
    if (wn >= 1 && wn <= 3 && first3[wn - 1]) {
        return { start_date: first3[wn - 1].start_date, end_date: first3[wn - 1].end_date };
    }
    const slots = compactFourSlots(year, monthNumber);
    if (slots.length) {
        const idx = Math.min(Math.max(wn - 1, 0), slots.length - 1);
        const s = slots[idx];
        return { start_date: s.start_date, end_date: s.end_date };
    }
    const s0 = getMonthWeek1Sunday(year, monthNumber);
    const start = new Date(s0);
    start.setDate(s0.getDate() + (wn - 1) * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 4);
    return { start_date: fmtLocalDate(start), end_date: fmtLocalDate(end) };
}

/** عدد أيام العمل (أحد–خميس) ضمن الفترة بحدود التواريخ الشاملين */
function countBillableDaysInRange(start_date, end_date) {
    const s = new Date(start_date);
    const e = new Date(end_date);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
    let n = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day !== 5 && day !== 6) n += 1;
    }
    return n;
}

/** أول/آخر يوم عمل (للتحقق) */
function trimToBillableEnds(start_date, end_date) {
    const s = new Date(start_date);
    const e = new Date(end_date);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null;
    let fs = new Date(s);
    while ((fs.getTime() <= e.getTime()) && (fs.getDay() === 5 || fs.getDay() === 6)) {
        fs.setDate(fs.getDate() + 1);
    }
    let fe = new Date(e);
    while ((fe.getTime() >= fs.getTime()) && (fe.getDay() === 5 || fe.getDay() === 6)) {
        fe.setDate(fe.getDate() - 1);
    }
    if (fe < fs) return null;
    return { start: fmtLocalDate(fs), end: fmtLocalDate(fe) };
}

/** يستنتج شهر/أسبوع النظام (1–4) من أي تاريخ عمل يقع داخل موضع */
function inferMonthWeekFromDate(year, isoDateStr) {
    for (let m = 1; m <= 12; m++) {
        for (let w = 1; w <= 4; w++) {
            const { start_date, end_date } = getWeekAutoDates(year, m, w);
            if (isoDateStr >= start_date && isoDateStr <= end_date) {
                return { month_number: m, week_number: w };
            }
        }
    }
    return null;
}

/** أيام المناسبات/العطل كمجموعة تواريخ YYYY-MM-DD */
function buildOccasionDaySet(occasions) {
    const set = new Set();
    for (const o of occasions) {
        if (!o.from_date) continue;
        const s = new Date(o.from_date + 'T12:00:00');
        const e = new Date((o.to_date || o.from_date) + 'T12:00:00');
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
            set.add(fmtLocalDate(d));
        }
    }
    return set;
}

/** أيام أحد–خميس في الفترة لا تقع ضمن مناسبة */
function countBillableDaysExcludingOccasions(start_date, end_date, occasionSet) {
    const s = new Date(start_date + 'T12:00:00');
    const e = new Date(end_date + 'T12:00:00');
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
    let n = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        const day = d.getDay();
        if (day === 5 || day === 6) continue;
        if (!occasionSet.has(fmtLocalDate(d))) n += 1;
    }
    return n;
}

module.exports = {
    fmtLocalDate,
    getMonthWeek1Sunday,
    listIntersectingWorkWeeks,
    compactFourSlots,
    getWeek4PayrollWeek,
    getWeekAutoDates,
    countBillableDaysInRange,
    trimToBillableEnds,
    inferMonthWeekFromDate,
    buildOccasionDaySet,
    countBillableDaysExcludingOccasions,
};
