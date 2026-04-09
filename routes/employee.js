const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database/db');
const ExcelJS = require('exceljs');

const avDir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(avDir, { recursive: true });
        cb(null, avDir);
    },
    filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname || '') || '.jpg').toLowerCase();
        const ok = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? ext : '.jpg';
        cb(null, `user-${req.session.user.id}${ok}`);
    },
});
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 2 * 1024 * 1024 } });
const {
    getWeekAutoDates,
    trimToBillableEnds,
    inferMonthWeekFromDate,
    buildOccasionDaySet,
    countBillableDaysExcludingOccasions,
} = require('../lib/weekUtils');

function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, message: 'غير مصرح' });
    }
    next();
}

/** السنة النشطة من الإعدادات فقط — بدون افتراض من تاريخ الجهاز */
function getActiveYearSetting() {
    const row = db.prepare("SELECT value FROM settings WHERE key='active_year'").get();
    if (!row || row.value === undefined || row.value === null || String(row.value).trim() === '') return null;
    const y = parseInt(String(row.value).trim(), 10);
    return Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : null;
}

function loadOccasionDaySet() {
    const occasions = db.prepare('SELECT * FROM occasions ORDER BY from_date').all();
    return buildOccasionDaySet(occasions);
}

/** مجموع أيام العمل من حصة الأسابيع: أيام leave_unit=week ناقص الجزء المدفوع من الرصيد المدور */
function getUsedWeekDayCredits(userId, year) {
    const row = db.prepare(`
        SELECT COALESCE(SUM(
            CASE WHEN IFNULL(leave_unit,'week')='week'
            THEN days_count - IFNULL(carried_days_used, 0) ELSE 0 END
        ), 0) as s FROM leaves
        WHERE user_id=? AND status!='cancelled' AND (year=? OR year IS NULL)
    `).get(userId, year);
    return row ? row.s : 0;
}

router.get('/me', requireAuth, (req, res) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
        if (!user) return res.json({ success: false, message: 'لم يتم العثور على المستخدم' });
        res.json({ success: true, user });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/active-year', requireAuth, (req, res) => {
    try {
        const y = getActiveYearSetting();
        res.json({ success: y !== null, year: y, message: y === null ? 'لم يتم تعيين سنة نشطة من المسؤول' : '' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/year-week-grid', requireAuth, (req, res) => {
    try {
        const y = getActiveYearSetting();
        if (y === null) return res.json({ success: false, noActiveYear: true });
        const grid = {};
        for (let m = 1; m <= 12; m++) {
            grid[m] = {};
            for (let w = 1; w <= 4; w++) {
                grid[m][w] = getWeekAutoDates(y, m, w);
            }
        }
        res.json({ success: true, year: y, grid });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.get('/my-leaves', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const y = getActiveYearSetting();
        if (y === null) {
            return res.json({ success: true, leaves: [], noActiveYear: true });
        }
        const leaves = db.prepare(
            'SELECT * FROM leaves WHERE user_id=? AND (year=? OR year IS NULL) ORDER BY month_number, week_number'
        ).all(userId, y);
        res.json({ success: true, leaves, activeYear: y });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.post('/submit-leave', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const { month_number, week_number, start_date, end_date, employee_note } = req.body;
        const activeYear = getActiveYearSetting();
        if (activeYear === null) {
            return res.json({ success: false, message: 'لم يتم تعيين سنة نشطة من المسؤول — لا يمكن تسجيل إجازة' });
        }

        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        if (!user) return res.json({ success: false, message: 'المستخدم غير موجود' });

        const occasionSet = loadOccasionDaySet();
        const maxDayCredits = (user.annual_leave_weeks || 0) * 5;
        const usedWeekCredits = getUsedWeekDayCredits(userId, activeYear);

        const requestedDayMode = !!(start_date && end_date);

        if (!requestedDayMode) {
            if (!month_number || !week_number) return res.json({ success: false, message: 'بيانات غير مكتملة' });
            const monthNum = parseInt(month_number, 10);
            const weekNum = parseInt(week_number, 10);

            const existing = db.prepare(
                "SELECT id FROM leaves WHERE user_id=? AND month_number=? AND week_number=? AND status!='cancelled'"
            ).get(userId, monthNum, weekNum);
            if (existing) return res.json({ success: false, message: 'لديك إجازة مسجلة بالفعل لهذا الأسبوع' });

            const blockedRow = db.prepare(
                "SELECT reason FROM blocked_periods WHERE (type='week' AND year=? AND month_number=? AND week_number=?) OR (type='month' AND year=? AND month_number=?)"
            ).get(activeYear, monthNum, weekNum, activeYear, monthNum);
            if (blockedRow) {
                const r = blockedRow.reason ? ` — ${blockedRow.reason}` : '';
                return res.json({ success: false, message: `هذا الأسبوع محجوز من المسؤول (استثناء)${r}` });
            }

            if (weekNum === 4 && !user.allow_week4) {
                const hasPermission = db.prepare(
                    'SELECT id FROM week4_permissions WHERE user_id=? AND year=? AND month_number=?'
                ).get(userId, activeYear, monthNum);
                if (!hasPermission) return res.json({ success: false, message: 'فترة الرواتب (الموضع الرابع) محجوزة لهذا الشهر — اطلب فك الحجز لهذا الشهر فقط' });
            }

            const maxSetting = db.prepare("SELECT value FROM settings WHERE key='default_max_per_week'").get();
            const defaultMax = maxSetting ? parseInt(maxSetting.value) : 3;
            const capOverride = db.prepare(
                'SELECT max_employees FROM week_capacity WHERE year=? AND month_number=? AND week_number=?'
            ).get(activeYear, monthNum, weekNum);
            const maxAllowed = capOverride ? capOverride.max_employees : defaultMax;
            const currentCount = db.prepare(
                "SELECT COUNT(*) as cnt FROM leaves WHERE month_number=? AND week_number=? AND status!='cancelled' AND user_id!=? AND (year=? OR year IS NULL)"
            ).get(monthNum, weekNum, userId, activeYear).cnt;
            if (currentCount >= maxAllowed) {
                return res.json({ success: false, message: `الأسبوع ممتلئ (الحد الأقصى ${maxAllowed} موظفين)` });
            }

            const auto = getWeekAutoDates(activeYear, monthNum, weekNum);
            const effectiveDays = countBillableDaysExcludingOccasions(auto.start_date, auto.end_date, occasionSet);
            if (effectiveDays === 0) {
                return res.json({
                    success: false,
                    message: 'جميع أيام هذا الموضع (أحد–خميس) تقع ضمن عطل/مناسبات مسجلة — لا يمكن احتساب إجازة هنا',
                });
            }
            const remainingWeek = Math.max(0, maxDayCredits - usedWeekCredits);
            const fromWeek = Math.min(effectiveDays, remainingWeek);
            const needCarried = effectiveDays - fromWeek;
            if (needCarried > (user.carried_over_days || 0)) {
                return res.json({
                    success: false,
                    message: needCarried > 0 && remainingWeek === 0
                        ? `استنفدت حصة الأسابيع (${maxDayCredits} يوم). يلزمك ${needCarried} يوم من الرصيد المدور ولديك ${user.carried_over_days || 0} يوم فقط.`
                        : `تجاوز الحد: متبقٍّ من حصة الأسابيع ${remainingWeek} يوم، والطلب يحتاج ${needCarried} يوماً إضافياً من الرصيد المدور ولديك ${user.carried_over_days || 0} يوم.`,
                });
            }

            const tx = db.transaction(() => {
                db.prepare(
                    `INSERT INTO leaves (user_id, month_number, week_number, start_date, end_date, employee_note, year, status, leave_unit, days_count, carried_days_used)
                     VALUES (?,?,?,?,?,?,?,'active',?,?,?)`
                ).run(
                    userId, monthNum, weekNum, auto.start_date, auto.end_date, employee_note || null, activeYear,
                    'week', effectiveDays, needCarried
                );
                if (needCarried > 0) {
                    db.prepare('UPDATE users SET carried_over_days = carried_over_days - ? WHERE id = ? AND carried_over_days >= ?').run(
                        needCarried, userId, needCarried
                    );
                }
            });
            tx();

            try {
                db.prepare("INSERT INTO notifications (user_id, for_admin, type, message) VALUES (?,1,?,?)")
                    .run(userId, 'leave', `${user.name} سجّل إجازة — شهر ${month_number} أسبوع ${week_number}`);
            } catch (ne) {}

            return res.json({ success: true, message: 'تم تسجيل الإجازة بنجاح ✓' });
        }

        const trimmed = trimToBillableEnds(start_date, end_date);
        if (!trimmed) {
            return res.json({ success: false, message: 'الفترة لا تشمل أيام عمل (أحد–خميس) — الجمعة والسبت لا تُحتسب ضمن الإجازة' });
        }
        const billable = countBillableDaysExcludingOccasions(trimmed.start, trimmed.end, occasionSet);
        if (billable === 0) {
            return res.json({
                success: false,
                message: 'لا توجد أيام تُحتسب — التواريخ إما عطل رسمية (مناسبات) أو جمعة/سبت فقط',
            });
        }

        const ts = new Date(trimmed.start + 'T12:00:00');
        const te = new Date(trimmed.end + 'T12:00:00');
        if (Number.isNaN(ts.getTime()) || Number.isNaN(te.getTime())) {
            return res.json({ success: false, message: 'تاريخ الإجازة غير صالح' });
        }
        if (ts.getFullYear() !== activeYear || te.getFullYear() !== activeYear) {
            return res.json({ success: false, message: `التواريخ يجب أن تكون ضمن السنة النشطة (${activeYear})` });
        }

        let monthNum;
        let weekNum;
        if (month_number && week_number) {
            monthNum = parseInt(month_number, 10);
            weekNum = parseInt(week_number, 10);
            const win = getWeekAutoDates(activeYear, monthNum, weekNum);
            if (trimmed.start < win.start_date || trimmed.end > win.end_date) {
                return res.json({ success: false, message: 'تواريخ الإجازة يجب أن تقع ضمن الأسبوع المختار (أحد–خميس لهذا الموضع)' });
            }
        } else {
            const infS = inferMonthWeekFromDate(activeYear, trimmed.start);
            const infE = inferMonthWeekFromDate(activeYear, trimmed.end);
            if (!infS || !infE || infS.month_number !== infE.month_number || infS.week_number !== infE.week_number) {
                return res.json({
                    success: false,
                    message: 'امتداد الإجازة يقطع أكثر من أسبوع عمل — سجّل طلبين أو اختر شهراً وأسبوعاً يغطيان الفترة',
                });
            }
            monthNum = infS.month_number;
            weekNum = infS.week_number;
        }

        const existing = db.prepare(
            "SELECT id FROM leaves WHERE user_id=? AND month_number=? AND week_number=? AND status!='cancelled'"
        ).get(userId, monthNum, weekNum);
        if (existing) return res.json({ success: false, message: 'لديك إجازة مسجلة بالفعل لهذا الأسبوع' });

        const blockedRow = db.prepare(
            "SELECT reason FROM blocked_periods WHERE (type='week' AND year=? AND month_number=? AND week_number=?) OR (type='month' AND year=? AND month_number=?)"
        ).get(activeYear, monthNum, weekNum, activeYear, monthNum);
        if (blockedRow) {
            const r = blockedRow.reason ? ` — ${blockedRow.reason}` : '';
            return res.json({ success: false, message: `هذا الأسبوع محجوز من المسؤول (استثناء)${r}` });
        }

        if (weekNum === 4 && !user.allow_week4) {
            const hasPermission = db.prepare(
                'SELECT id FROM week4_permissions WHERE user_id=? AND year=? AND month_number=?'
            ).get(userId, activeYear, monthNum);
            if (!hasPermission) return res.json({ success: false, message: 'فترة الرواتب (الموضع الرابع) محجوزة لهذا الشهر — اطلب فك الحجز لهذا الشهر فقط' });
        }

        const maxSetting = db.prepare("SELECT value FROM settings WHERE key='default_max_per_week'").get();
        const defaultMax = maxSetting ? parseInt(maxSetting.value) : 3;
        const capOverride = db.prepare(
            'SELECT max_employees FROM week_capacity WHERE year=? AND month_number=? AND week_number=?'
        ).get(activeYear, monthNum, weekNum);
        const maxAllowed = capOverride ? capOverride.max_employees : defaultMax;
        const currentCount = db.prepare(
            "SELECT COUNT(*) as cnt FROM leaves WHERE month_number=? AND week_number=? AND status!='cancelled' AND user_id!=? AND (year=? OR year IS NULL)"
        ).get(monthNum, weekNum, userId, activeYear).cnt;
        if (currentCount >= maxAllowed) {
            return res.json({ success: false, message: `الأسبوع ممتلئ (الحد الأقصى ${maxAllowed} موظفين)` });
        }

        const carried = user.carried_over_days || 0;
        const remainingWeek = Math.max(0, maxDayCredits - usedWeekCredits);
        let leaveUnit;
        let daysCount = billable;
        let carriedUsed = 0;

        if (billable > 5) {
            return res.json({ success: false, message: 'لا يمكن تسجيل أكثر من خمسة أيام عمل في أسبوع نظامي واحد (أحد–خميس)' });
        }

        if (billable <= remainingWeek) {
            leaveUnit = 'week';
            daysCount = billable;
            carriedUsed = 0;
        } else {
            const needCarried = billable - remainingWeek;
            if (needCarried > carried) {
                return res.json({
                    success: false,
                    message: `لا يكفي الرصيد: من حصة الأسابيع متبقٍّ ${remainingWeek} يوم، والطلب يحتاج ${needCarried} يوماً من الرصيد المدور ولديك ${carried} يوم.`,
                });
            }
            if (remainingWeek === 0) {
                leaveUnit = 'day';
                daysCount = billable;
                carriedUsed = 0;
                db.prepare('UPDATE users SET carried_over_days = carried_over_days - ? WHERE id = ? AND carried_over_days >= ?').run(
                    billable, userId, billable
                );
            } else {
                leaveUnit = 'week';
                daysCount = billable;
                carriedUsed = needCarried;
                db.prepare('UPDATE users SET carried_over_days = carried_over_days - ? WHERE id = ? AND carried_over_days >= ?').run(
                    needCarried, userId, needCarried
                );
            }
        }

        db.prepare(
            `INSERT INTO leaves (user_id, month_number, week_number, start_date, end_date, employee_note, year, status, leave_unit, days_count, carried_days_used)
             VALUES (?,?,?,?,?,?,?,'active',?,?,?)`
        ).run(userId, monthNum, weekNum, trimmed.start, trimmed.end, employee_note || null, activeYear, leaveUnit, daysCount, carriedUsed);

        try {
            db.prepare("INSERT INTO notifications (user_id, for_admin, type, message) VALUES (?,1,?,?)")
                .run(userId, 'leave', `${user.name} سجّل إجازة بالأيام — شهر ${monthNum} أسبوع ${weekNum}`);
        } catch (ne) {}

        res.json({ success: true, message: 'تم تسجيل الإجازة بنجاح ✓' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/cancel-leave', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const { leave_id } = req.body;
        const leave = db.prepare('SELECT * FROM leaves WHERE id=? AND user_id=?').get(leave_id, userId);
        if (!leave) return res.json({ success: false, message: 'الإجازة غير موجودة' });
        const tx = db.transaction(() => {
            db.prepare("UPDATE leaves SET status='cancelled' WHERE id=?").run(leave_id);
            const unit = leave.leave_unit || 'week';
            if (unit === 'day') {
                const back = parseInt(leave.days_count, 10) || 0;
                if (back > 0) {
                    db.prepare('UPDATE users SET carried_over_days = carried_over_days + ? WHERE id=?').run(back, userId);
                }
            } else {
                const cd = parseInt(leave.carried_days_used, 10) || 0;
                if (cd > 0) {
                    db.prepare('UPDATE users SET carried_over_days = carried_over_days + ? WHERE id=?').run(cd, userId);
                }
            }
        });
        tx();
        res.json({ success: true, message: 'تم إلغاء الإجازة' });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.post('/request-week4', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const { reason, month_number } = req.body;
        const activeYear = getActiveYearSetting();
        if (activeYear === null) return res.json({ success: false, message: 'لم يتم تعيين سنة نشطة — لا يمكن إرسال الطلب' });
        const monthNum = parseInt(month_number, 10);
        if (!monthNum || monthNum < 1 || monthNum > 12) return res.json({ success: false, message: 'اختر الشهر المطلوب لفك الحجز' });
        const existing = db.prepare("SELECT id FROM week4_requests WHERE user_id=? AND month_number=? AND year=? AND status='pending'").get(userId, monthNum, activeYear);
        if (existing) return res.json({ success: false, message: 'لديك طلب معلق لهذا الشهر بالفعل' });
        db.prepare("INSERT INTO week4_requests (user_id, month_number, year, reason, status) VALUES (?,?,?,?, 'pending')").run(userId, monthNum, activeYear, reason || '');
        const user = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
        try {
            db.prepare("INSERT INTO notifications (user_id, for_admin, type, message) VALUES (?,1,?,?)")
                .run(userId, 'week4', `${user.name} طلب فك حجز فترة الرواتب لشهر ${monthNum}`);
        } catch(ne) {}
        res.json({ success: true, message: 'تم إرسال الطلب بنجاح — سيتم إشعارك بالرد' });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/my-week4-requests', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const requests = db.prepare('SELECT * FROM week4_requests WHERE user_id=? ORDER BY created_at DESC').all(userId);
        res.json({ success: true, requests });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.post('/request-swap', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const { my_leave_id, target_leave_id, reason } = req.body;
        const myLeave = db.prepare('SELECT * FROM leaves WHERE id=? AND user_id=?').get(my_leave_id, userId);
        const targetLeave = db.prepare('SELECT * FROM leaves WHERE id=?').get(target_leave_id);
        if (!myLeave || !targetLeave) return res.json({ success: false, message: 'إجازة غير موجودة' });
        const existing = db.prepare(
            `SELECT id FROM swap_requests WHERE requester_id=? AND my_leave_id=?
             AND status IN ('pending_peer','pending')`
        ).get(userId, my_leave_id);
        if (existing) return res.json({ success: false, message: 'لديك طلب تبديل معلق لهذه الإجازة' });
        db.prepare(
            "INSERT INTO swap_requests (requester_id, target_user_id, my_leave_id, their_leave_id, reason, target_status, status) VALUES (?,?,?,?,?, 'pending', 'pending_peer')"
        ).run(userId, targetLeave.user_id, my_leave_id, target_leave_id, reason || '');
        db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)')
            .run(targetLeave.user_id, 'لديك طلب تبديل جديد بانتظار موافقتك', 'swap_peer');
        res.json({ success: true, message: 'تم إرسال الطلب للطرف الآخر أولاً' });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/incoming-swap-requests', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const requests = db.prepare(`
            SELECT s.*, u.name as requester_name, u.employee_id as requester_emp,
                   lm.month_number as req_month, lm.week_number as req_week,
                   lt.month_number as tar_month, lt.week_number as tar_week
            FROM swap_requests s
            JOIN users u ON s.requester_id=u.id
            JOIN leaves lm ON s.my_leave_id=lm.id
            JOIN leaves lt ON s.their_leave_id=lt.id
            WHERE s.target_user_id=? AND s.status='pending_peer'
            ORDER BY s.created_at DESC
        `).all(userId);
        res.json({ success: true, requests });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.post('/swap-requests/respond', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const { id, action, note } = req.body;
        const swap = db.prepare('SELECT * FROM swap_requests WHERE id=? AND target_user_id=?').get(id, userId);
        if (!swap) return res.json({ success: false, message: 'الطلب غير موجود' });
        if (action === 'accept') {
            db.prepare("UPDATE swap_requests SET target_status='accepted', target_note=?, status='pending' WHERE id=?").run(note || '', id);
            db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(swap.requester_id, 'وافق الطرف الآخر على طلب التبديل وتم رفعه للمسؤول', 'swap_peer_ok');
            return res.json({ success: true, message: 'تمت الموافقة ورفع الطلب للمسؤول' });
        }
        db.prepare("UPDATE swap_requests SET target_status='rejected', target_note=?, status='rejected' WHERE id=?").run(note || '', id);
        db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(swap.requester_id, 'تم رفض طلب التبديل من الطرف الآخر', 'swap_peer_no');
        res.json({ success: true, message: 'تم رفض الطلب' });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/leaves-by-employee/:employee_id', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const y = getActiveYearSetting();
        if (y === null) return res.json({ success: false, message: 'لم تُعرَّف سنة نشطة' });
        const target = db.prepare('SELECT id,name,employee_id FROM users WHERE employee_id=? AND is_admin=0').get(req.params.employee_id);
        if (!target || target.id === userId) return res.json({ success: false, message: 'الموظف غير موجود' });
        const leaves = db.prepare(
            "SELECT * FROM leaves WHERE user_id=? AND status!='cancelled' AND (year=? OR year IS NULL) ORDER BY month_number,week_number"
        ).all(target.id, y);
        res.json({ success: true, target, leaves, activeYear: y });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/my-swap-requests', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const requests = db.prepare(`
      SELECT sr.*,
        u1.name as requester_name, l1.month_number as req_month, l1.week_number as req_week,
        u2.name as target_name, l2.month_number as tar_month, l2.week_number as tar_week
      FROM swap_requests sr
      JOIN users u1 ON sr.requester_id=u1.id
      JOIN leaves l1 ON sr.my_leave_id=l1.id
      JOIN leaves l2 ON sr.their_leave_id=l2.id
      JOIN users u2 ON l2.user_id=u2.id
      WHERE sr.requester_id=? OR l2.user_id=?
      ORDER BY sr.created_at DESC
    `).all(userId, userId);
        res.json({ success: true, requests });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/all-leaves-for-swap', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const leaves = db.prepare(`
      SELECT l.*, u.name, u.employee_id
      FROM leaves l JOIN users u ON l.user_id=u.id
      WHERE l.user_id!=? AND l.status!='cancelled' AND u.is_admin=0
      ORDER BY l.month_number, l.week_number
    `).all(userId);
        res.json({ success: true, leaves });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/occasions', requireAuth, (req, res) => {
    try {
        const occasions = db.prepare('SELECT * FROM occasions ORDER BY from_date').all();
        res.json({ success: true, occasions });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.get('/calendar-data', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const y = getActiveYearSetting();
        if (y === null) {
            return res.json({
                success: true, occasions: [], myLeaves: [], blocked: [], density: [], defaultMax: 3,
                activeYear: null, noActiveYear: true
            });
        }
        function occasionOverlapsYear(o) {
            if (!o.from_date) return false;
            const s = new Date(o.from_date);
            const e = new Date(o.to_date || o.from_date);
            const startY = new Date(y, 0, 1);
            const endY = new Date(y, 11, 31, 23, 59, 59);
            return s <= endY && e >= startY;
        }
        const occasions = db.prepare('SELECT * FROM occasions ORDER BY from_date').all().filter(occasionOverlapsYear);
        const myLeaves = db.prepare(
            "SELECT * FROM leaves WHERE user_id=? AND status!='cancelled' AND (year=? OR year IS NULL)"
        ).all(userId, y);
        const blocked = db.prepare('SELECT * FROM blocked_periods WHERE year=? OR year IS NULL').all(y);
        const density = db.prepare(`
            SELECT month_number, week_number, COUNT(*) as cnt
            FROM leaves WHERE status!='cancelled' AND (year=? OR year IS NULL)
            GROUP BY month_number, week_number
        `).all(y);
        const maxSetting = db.prepare("SELECT value FROM settings WHERE key='default_max_per_week'").get();
        const defaultMax = maxSetting ? parseInt(maxSetting.value, 10) : 3;
        res.json({ success: true, occasions, myLeaves, blocked, density, defaultMax, activeYear: y });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.post('/change-password', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const { current_password, new_password } = req.body;
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
        if (!user || user.password !== current_password) return res.json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
        if (!new_password || String(new_password).trim().length < 4) return res.json({ success: false, message: 'كلمة المرور الجديدة قصيرة' });
        db.prepare('UPDATE users SET password=? WHERE id=?').run(String(new_password).trim(), userId);
        res.json({ success: true, message: 'تم تغيير كلمة المرور' });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

function settingPath(rel) {
    if (!rel || typeof rel !== 'string') return null;
    const t = rel.trim();
    if (!t.startsWith('/')) return null;
    const full = path.join(__dirname, '..', 'public', t.replace(/^\//, ''));
    return fs.existsSync(full) ? full : null;
}

router.post('/profile/avatar', requireAuth, avatarUpload.single('avatar'), (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, message: 'لم يتم اختيار ملف' });
        const url = '/uploads/avatars/' + req.file.filename;
        db.prepare('UPDATE users SET avatar_url=? WHERE id=?').run(url, req.session.user.id);
        req.session.user.avatar_url = url;
        res.json({ success: true, avatar_url: url });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/profile/theme', requireAuth, (req, res) => {
    try {
        const { accent_color } = req.body;
        const hex = String(accent_color || '').trim();
        if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return res.json({ success: false, message: 'لون غير صالح (استخدم #RRGGBB)' });
        db.prepare('UPDATE users SET accent_color=? WHERE id=?').run(hex, req.session.user.id);
        req.session.user.accent_color = hex;
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

router.get('/leave-report', requireAuth, (req, res) => {
    try {
        const lang = req.query.lang === 'en' ? 'en' : 'ar';
        const userId = req.session.user.id;
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
        const y = getActiveYearSetting();
        if (y === null) {
            const msg = lang === 'en' ? 'No active year is set.' : 'لم يتم تعيين سنة نشطة.';
            return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report</title></head><body><p>${escapeHtml(msg)}</p></body></html>`);
        }
        const logoRow = db.prepare("SELECT value FROM settings WHERE key='site_logo'").get();
        const logoUrl = logoRow && logoRow.value ? String(logoRow.value).trim() : '';
        const leaves = db.prepare(
            "SELECT * FROM leaves WHERE user_id=? AND status!='cancelled' AND (year=? OR year IS NULL) ORDER BY month_number, week_number, start_date"
        ).all(userId, y);
        const months = ['', 'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
        const monthsEn = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const L = lang === 'en'
            ? {
                title: 'Leave report',
                sub: 'Year',
                colMonth: 'Month',
                colWeek: 'Week',
                colFrom: 'From',
                colTo: 'To',
                colUnit: 'Type',
                colStatus: 'Status',
                unitDay: 'Day',
                unitWeek: 'Week',
                stReg: 'Recorded',
                stCan: 'Cancelled',
                weekPrefix: 'Week',
                empty: 'No leaves recorded',
                print: 'Print / Save as PDF',
                excel: 'Download Excel',
                close: 'Close',
            }
            : {
                title: 'تقرير إجازات الموظف',
                sub: 'السنة',
                colMonth: 'الشهر',
                colWeek: 'الأسبوع',
                colFrom: 'من',
                colTo: 'إلى',
                colUnit: 'النوع',
                colStatus: 'الحالة',
                unitDay: 'يوم',
                unitWeek: 'أسبوع',
                stReg: 'مسجلة',
                stCan: 'ملغاة',
                weekPrefix: 'الأسبوع',
                empty: 'لا توجد إجازات مسجلة',
                print: '🖨️ طباعة / حفظ PDF',
                excel: '⬇️ تنزيل Excel',
                close: 'إغلاق',
            };
        const rows = leaves.map((l) => {
            const unit = (l.leave_unit || 'week') === 'day' ? L.unitDay : L.unitWeek;
            const mnames = lang === 'en' ? monthsEn : months;
            const wk = l.week_number != null ? `${L.weekPrefix} ${l.week_number}` : '—';
            return `<tr>
                <td>${escapeHtml(mnames[l.month_number] || l.month_number)}</td>
                <td>${wk}</td>
                <td>${escapeHtml(l.start_date || '—')}</td>
                <td>${escapeHtml(l.end_date || '—')}</td>
                <td>${unit}</td>
                <td>${l.status === 'cancelled' ? L.stCan : L.stReg}</td>
            </tr>`;
        }).join('');
        const logoBlock = logoUrl
            ? `<div class="logo-wrap"><img src="${escapeHtml(logoUrl)}" alt="Logo" class="logo-img"></div>`
            : '';
        const dir = lang === 'en' ? 'ltr' : 'rtl';
        const align = lang === 'en' ? 'left' : 'right';
        const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(L.title)} — ${escapeHtml(user.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; color: #222; }
  .sheet { max-width: 900px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); overflow: hidden; }
  .head { padding: 20px 24px; border-bottom: 1px solid #eee; text-align: center; }
  .logo-wrap { margin-bottom: 12px; }
  .logo-img { max-height: 72px; max-width: 220px; object-fit: contain; }
  h1 { margin: 0 0 6px; font-size: 1.35rem; color: #1a3a5c; }
  .sub { color: #666; font-size: 0.95rem; margin: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 10px 12px; text-align: ${align}; border-bottom: 1px solid #eee; }
  th { background: #f8f0f1; color: #B22234; font-weight: 600; }
  tr:hover td { background: #fdf8f8; }
  .actions { padding: 16px 24px; display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; border-top: 1px solid #eee; }
  .btn { padding: 10px 18px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; font-family: inherit; text-decoration: none; display: inline-block; }
  .btn-primary { background: linear-gradient(135deg, #1a3a5c, #2d6a9f); color: #fff; }
  .btn-secondary { background: #eee; color: #333; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; border-radius: 0; }
    .actions { display: none; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="head">
    ${logoBlock}
    <h1>${escapeHtml(L.title)}</h1>
    <p class="sub">${escapeHtml(user.name)} — ${escapeHtml(user.employee_id)} — ${escapeHtml(L.sub)} ${y}</p>
  </div>
  <div style="overflow-x:auto;">
    <table>
      <thead><tr><th>${escapeHtml(L.colMonth)}</th><th>${escapeHtml(L.colWeek)}</th><th>${escapeHtml(L.colFrom)}</th><th>${escapeHtml(L.colTo)}</th><th>${escapeHtml(L.colUnit)}</th><th>${escapeHtml(L.colStatus)}</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="text-align:center;color:#888;">${escapeHtml(L.empty)}</td></tr>`}</tbody>
    </table>
  </div>
  <div class="actions">
    <button type="button" class="btn btn-primary" onclick="window.print()">${escapeHtml(L.print)}</button>
    <a class="btn btn-secondary" href="/employee/export-my-leaves" target="_blank" rel="noopener">${escapeHtml(L.excel)}</a>
    <button type="button" class="btn btn-secondary" onclick="window.close()">${escapeHtml(L.close)}</button>
  </div>
</div>
</body>
</html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) {
        res.status(500).send('<!DOCTYPE html><html><body><p>' + escapeHtml(e.message) + '</p></body></html>');
    }
});

router.get('/export-my-leaves', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
        const y = getActiveYearSetting();
        if (y === null) return res.json({ success: false, message: 'لم يتم تعيين سنة نشطة' });
        const leaves = db.prepare(
            "SELECT * FROM leaves WHERE user_id=? AND status!='cancelled' AND (year=? OR year IS NULL) ORDER BY month_number,week_number"
        ).all(userId, y);
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('اجازاتي');
        ws.views = [{ rightToLeft: true }];
        const logoFull = settingPath((db.prepare("SELECT value FROM settings WHERE key='site_logo'").get() || {}).value || '');
        let logoRows = 0;
        if (logoFull) {
            const ext = path.extname(logoFull).slice(1).toLowerCase();
            const imageExtension = ext === 'jpg' ? 'jpeg' : ext;
            if (['png', 'jpeg', 'gif'].includes(imageExtension)) {
                try {
                    const imageId = wb.addImage({ filename: logoFull, extension: imageExtension });
                    ws.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 180, height: 72 } });
                    ws.getRow(1).height = 56;
                    logoRows = 1;
                } catch (_) {}
            }
        }
        const titleRow = logoRows + 1;
        const titleR = ws.getRow(titleRow);
        titleR.getCell(1).value = `تقرير إجازات ${user.name} (${user.employee_id}) — السنة ${y}`;
        ws.mergeCells(`A${titleRow}:F${titleRow}`);
        titleR.font = { bold: true, size: 14 };
        const headerRow = titleRow + 1;
        const hdr = ws.getRow(headerRow);
        const headers = ['الشهر', 'الأسبوع', 'من', 'إلى', 'النوع', 'الحالة'];
        headers.forEach((h, i) => {
            const c = hdr.getCell(i + 1);
            c.value = h;
            c.font = { bold: true, color: { argb: 'FFB22234' } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F0F1' } };
        });
        let r = headerRow + 1;
        const months = ['', 'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
        leaves.forEach((l) => {
            const row = ws.getRow(r);
            row.getCell(1).value = months[l.month_number] || l.month_number;
            row.getCell(2).value = `الأسبوع ${l.week_number}`;
            row.getCell(3).value = l.start_date || '-';
            row.getCell(4).value = l.end_date || '-';
            row.getCell(5).value = (l.leave_unit || 'week') === 'day' ? 'يوم' : 'أسبوع';
            row.getCell(6).value = l.status === 'cancelled' ? 'ملغاة' : 'مسجلة';
            r++;
        });
        ws.columns = [{ width: 16 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }];
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="my_leaves_${user.employee_id}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.get('/notifications', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        const notifications = db.prepare(
            'SELECT * FROM notifications WHERE user_id=? AND for_admin=0 ORDER BY created_at DESC LIMIT 20'
        ).all(userId);
        const unread = db.prepare(
            'SELECT COUNT(*) as cnt FROM notifications WHERE user_id=? AND for_admin=0 AND is_read=0'
        ).get(userId).cnt;
        res.json({ success: true, notifications, unread });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

router.post('/notifications/read-all', requireAuth, (req, res) => {
    try {
        const userId = req.session.user.id;
        db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND for_admin=0').run(userId);
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: e.message }); }
});

module.exports = router;