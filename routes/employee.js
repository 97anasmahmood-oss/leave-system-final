const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ExcelJS = require('exceljs');

const User = require('../models/User');
const Leave = require('../models/Leave');
const BlockedPeriod = require('../models/BlockedPeriod');
const Occasion = require('../models/Occasion');
const Setting = require('../models/Setting');
const WeekCapacity = require('../models/WeekCapacity');
const Week4Permission = require('../models/Week4Permission');
const Week4Request = require('../models/Week4Request');
const SwapRequest = require('../models/SwapRequest');
const Notification = require('../models/Notification');

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

async function getActiveYearSetting() {
    const row = await Setting.findOne({ key: 'active_year' }).lean();
    if (!row || row.value === undefined || row.value === null || String(row.value).trim() === '') return null;
    const y = parseInt(String(row.value).trim(), 10);
    return Number.isFinite(y) && y >= 2000 && y <= 2100 ? y : null;
}

async function loadOccasionDaySet() {
    const occasions = await Occasion.find({}).sort({ from_date: 1 }).lean();
    return buildOccasionDaySet(occasions);
}

async function getUsedWeekDayCredits(userId, year) {
    const rows = await Leave.aggregate([
        {
            $match: {
                user_id: userId,
                status: { $ne: 'cancelled' },
                $and: [
                    { $or: [{ year }, { year: null }, { year: { $exists: false } }] },
                    { $or: [{ leave_unit: 'week' }, { leave_unit: null }, { leave_unit: { $exists: false } }] },
                ],
            },
        },
        {
            $group: {
                _id: null,
                s: {
                    $sum: {
                        $subtract: [
                            { $ifNull: ['$days_count', 5] },
                            { $ifNull: ['$carried_days_used', 0] },
                        ],
                    },
                },
            },
        },
    ]);
    return rows[0]?.s || 0;
}

router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.session.user.id).lean();
        if (!user) return res.json({ success: false, message: 'لم يتم العثور على المستخدم' });
        res.json({ success: true, user: { ...user, id: String(user._id) } });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/active-year', requireAuth, async (req, res) => {
    try {
        const y = await getActiveYearSetting();
        res.json({ success: y !== null, year: y, message: y === null ? 'لم يتم تعيين سنة نشطة من المسؤول' : '' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/year-week-grid', requireAuth, async (req, res) => {
    try {
        const y = await getActiveYearSetting();
        if (y === null) return res.json({ success: false, noActiveYear: true });
        const grid = {};
        for (let m = 1; m <= 12; m++) {
            grid[m] = {};
            for (let w = 1; w <= 4; w++) {
                grid[m][w] = getWeekAutoDates(y, m, w);
            }
        }
        res.json({ success: true, year: y, grid });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/my-leaves', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const y = await getActiveYearSetting();
        if (y === null) return res.json({ success: true, leaves: [], noActiveYear: true });
        const leaves = await Leave.find({
            user_id: userId,
            $or: [{ year: y }, { year: null }, { year: { $exists: false } }],
        }).sort({ month_number: 1, week_number: 1 }).lean();
        res.json({ success: true, leaves: leaves.map(l => ({ ...l, id: String(l._id) })), activeYear: y });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.post('/submit-leave', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { month_number, week_number, start_date, end_date, employee_note } = req.body;
        const activeYear = await getActiveYearSetting();
        if (activeYear === null) {
            return res.json({ success: false, message: 'لم يتم تعيين سنة نشطة من المسؤول — لا يمكن تسجيل إجازة' });
        }

        const user = await User.findById(userId).lean();
        if (!user) return res.json({ success: false, message: 'المستخدم غير موجود' });

        const annualWeeks = Number.isFinite(parseInt(user.annual_leave_weeks, 10))
            ? parseInt(user.annual_leave_weeks, 10)
            : 3;
        const maxLeaveEntries = Math.max(0, annualWeeks);
        const usedLeaveEntries = await Leave.countDocuments({
            user_id: userId,
            status: { $ne: 'cancelled' },
            $or: [{ year: activeYear }, { year: null }, { year: { $exists: false } }],
        });
        if (usedLeaveEntries >= maxLeaveEntries) {
            const carriedAvail = user.carried_over_days || 0;
            if (carriedAvail <= 0) {
                return res.json({
                    success: false,
                    message: `استنفدت الحد المسموح لعدد الإجازات (${maxLeaveEntries}) لهذه السنة ولا يوجد رصيد مدور متاح.`,
                });
            }
        }

        const occasionSet = await loadOccasionDaySet();
        const maxDayCredits = (user.annual_leave_weeks || 0) * 5;
        const usedWeekCredits = await getUsedWeekDayCredits(userId, activeYear);

        const requestedDayMode = !!(start_date && end_date);

        async function ensureNoExisting(monthNum, weekNum) {
            const existing = await Leave.findOne({
                user_id: userId,
                month_number: monthNum,
                week_number: weekNum,
                status: { $ne: 'cancelled' },
            }).lean();
            if (existing) return { ok: false, message: 'لديك إجازة مسجلة بالفعل لهذا الأسبوع' };
            return { ok: true };
        }

        async function ensureNotBlocked(monthNum, weekNum) {
            const blockedRow = await BlockedPeriod.findOne({
                $or: [
                    { type: 'week', year: activeYear, month_number: monthNum, week_number: weekNum },
                    { type: 'month', year: activeYear, month_number: monthNum },
                ],
            }).lean();
            if (blockedRow) {
                const r = blockedRow.reason ? ` — ${blockedRow.reason}` : '';
                return { ok: false, message: `هذا الأسبوع محجوز من المسؤول (استثناء)${r}` };
            }
            return { ok: true };
        }

        async function ensureWeek4Allowed(monthNum, weekNum) {
            if (weekNum !== 4) return { ok: true };
            if (user.allow_week4) return { ok: true };
            const perm = await Week4Permission.findOne({ user_id: userId, year: activeYear, month_number: monthNum }).lean();
            if (!perm) return { ok: false, message: 'فترة الرواتب (الموضع الرابع) محجوزة لهذا الشهر — اطلب فك الحجز لهذا الشهر فقط' };
            return { ok: true };
        }

        async function getMaxAllowed(monthNum, weekNum) {
            const maxSetting = await Setting.findOne({ key: 'default_max_per_week' }).lean();
            const defaultMax = maxSetting ? parseInt(maxSetting.value, 10) : 3;
            const capOverride = await WeekCapacity.findOne({ year: activeYear, month_number: monthNum, week_number: weekNum }).lean();
            return capOverride ? capOverride.max_employees : defaultMax;
        }

        async function ensureCapacity(monthNum, weekNum) {
            const maxAllowed = await getMaxAllowed(monthNum, weekNum);
            const currentCount = await Leave.countDocuments({
                month_number: monthNum,
                week_number: weekNum,
                status: { $ne: 'cancelled' },
                user_id: { $ne: userId },
                $or: [{ year: activeYear }, { year: null }, { year: { $exists: false } }],
            });
            if (currentCount >= maxAllowed) return { ok: false, message: `الأسبوع ممتلئ (الحد الأقصى ${maxAllowed} موظفين)` };
            return { ok: true };
        }

        if (!requestedDayMode) {
            if (!month_number || !week_number) return res.json({ success: false, message: 'بيانات غير مكتملة' });
            const monthNum = parseInt(month_number, 10);
            const weekNum = parseInt(week_number, 10);

            const ex = await ensureNoExisting(monthNum, weekNum);
            if (!ex.ok) return res.json({ success: false, message: ex.message });

            const blk = await ensureNotBlocked(monthNum, weekNum);
            if (!blk.ok) return res.json({ success: false, message: blk.message });

            const w4 = await ensureWeek4Allowed(monthNum, weekNum);
            if (!w4.ok) return res.json({ success: false, message: w4.message });

            const cap = await ensureCapacity(monthNum, weekNum);
            if (!cap.ok) return res.json({ success: false, message: cap.message });

            const auto = getWeekAutoDates(activeYear, monthNum, weekNum);
            const effectiveDays = countBillableDaysExcludingOccasions(auto.start_date, auto.end_date, occasionSet);
            if (effectiveDays === 0) {
                return res.json({ success: false, message: 'جميع أيام هذا الموضع (أحد–خميس) تقع ضمن عطل/مناسبات مسجلة — لا يمكن احتساب إجازة هنا' });
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

            if (needCarried > 0) {
                await User.updateOne({ _id: userId, carried_over_days: { $gte: needCarried } }, { $inc: { carried_over_days: -needCarried } });
            }

            await Leave.create({
                user_id: userId,
                month_number: monthNum,
                week_number: weekNum,
                start_date: auto.start_date,
                end_date: auto.end_date,
                employee_note: employee_note || null,
                year: activeYear,
                status: 'active',
                leave_unit: 'week',
                days_count: effectiveDays,
                carried_days_used: needCarried,
            });

            await Notification.create({ user_id: userId, for_admin: true, type: 'leave', message: `${user.name} سجّل إجازة — شهر ${month_number} أسبوع ${week_number}` });
            return res.json({ success: true, message: 'تم تسجيل الإجازة بنجاح ✓' });
        }

        const trimmed = trimToBillableEnds(start_date, end_date);
        if (!trimmed) {
            return res.json({ success: false, message: 'الفترة لا تشمل أيام عمل (أحد–خميس) — الجمعة والسبت لا تُحتسب ضمن الإجازة' });
        }

        const billable = countBillableDaysExcludingOccasions(trimmed.start, trimmed.end, occasionSet);
        if (billable === 0) {
            return res.json({ success: false, message: 'لا توجد أيام تُحتسب — التواريخ إما عطل رسمية (مناسبات) أو جمعة/سبت فقط' });
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
                return res.json({ success: false, message: 'امتداد الإجازة يقطع أكثر من أسبوع عمل — سجّل طلبين أو اختر شهراً وأسبوعاً يغطيان الفترة' });
            }
            monthNum = infS.month_number;
            weekNum = infS.week_number;
        }

        const ex2 = await ensureNoExisting(monthNum, weekNum);
        if (!ex2.ok) return res.json({ success: false, message: ex2.message });

        const blk2 = await ensureNotBlocked(monthNum, weekNum);
        if (!blk2.ok) return res.json({ success: false, message: blk2.message });

        const w42 = await ensureWeek4Allowed(monthNum, weekNum);
        if (!w42.ok) return res.json({ success: false, message: w42.message });

        const cap2 = await ensureCapacity(monthNum, weekNum);
        if (!cap2.ok) return res.json({ success: false, message: cap2.message });

        const carried = user.carried_over_days || 0;
        const remainingWeek = Math.max(0, maxDayCredits - usedWeekCredits);
        if (billable > 5) return res.json({ success: false, message: 'لا يمكن تسجيل أكثر من خمسة أيام عمل في أسبوع نظامي واحد (أحد–خميس)' });

        let leaveUnit;
        let carriedUsed = 0;

        if (billable <= remainingWeek) {
            leaveUnit = 'week';
        } else {
            const needCarried = billable - remainingWeek;
            if (needCarried > carried) {
                return res.json({ success: false, message: `لا يكفي الرصيد: من حصة الأسابيع متبقٍّ ${remainingWeek} يوم، والطلب يحتاج ${needCarried} يوماً من الرصيد المدور ولديك ${carried} يوم.` });
            }
            if (remainingWeek === 0) {
                leaveUnit = 'day';
                await User.updateOne({ _id: userId, carried_over_days: { $gte: billable } }, { $inc: { carried_over_days: -billable } });
            } else {
                leaveUnit = 'week';
                carriedUsed = needCarried;
                await User.updateOne({ _id: userId, carried_over_days: { $gte: needCarried } }, { $inc: { carried_over_days: -needCarried } });
            }
        }

        await Leave.create({
            user_id: userId,
            month_number: monthNum,
            week_number: weekNum,
            start_date: trimmed.start,
            end_date: trimmed.end,
            employee_note: employee_note || null,
            year: activeYear,
            status: 'active',
            leave_unit: leaveUnit,
            days_count: billable,
            carried_days_used: carriedUsed,
        });

        await Notification.create({ user_id: userId, for_admin: true, type: 'leave', message: `${user.name} سجّل إجازة بالأيام — شهر ${monthNum} أسبوع ${weekNum}` });
        res.json({ success: true, message: 'تم تسجيل الإجازة بنجاح ✓' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/cancel-leave', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { leave_id } = req.body;
        const leave = await Leave.findOne({ _id: leave_id, user_id: userId }).lean();
        if (!leave) return res.json({ success: false, message: 'الإجازة غير موجودة' });
        await Leave.updateOne({ _id: leave_id, user_id: userId }, { $set: { status: 'cancelled' } });
        const unit = leave.leave_unit || 'week';
        if (unit === 'day') {
            const back = parseInt(leave.days_count, 10) || 0;
            if (back > 0) await User.updateOne({ _id: userId }, { $inc: { carried_over_days: back } });
        } else {
            const cd = parseInt(leave.carried_days_used, 10) || 0;
            if (cd > 0) await User.updateOne({ _id: userId }, { $inc: { carried_over_days: cd } });
        }
        res.json({ success: true, message: 'تم إلغاء الإجازة' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.post('/request-week4', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { reason, month_number } = req.body;
        const activeYear = await getActiveYearSetting();
        if (activeYear === null) return res.json({ success: false, message: 'لم يتم تعيين سنة نشطة — لا يمكن إرسال الطلب' });
        const monthNum = parseInt(month_number, 10);
        if (!monthNum || monthNum < 1 || monthNum > 12) return res.json({ success: false, message: 'اختر الشهر المطلوب لفك الحجز' });
        const existing = await Week4Request.findOne({ user_id: userId, month_number: monthNum, year: activeYear, status: 'pending' }).lean();
        if (existing) return res.json({ success: false, message: 'لديك طلب معلق لهذا الشهر بالفعل' });
        await Week4Request.create({ user_id: userId, month_number: monthNum, year: activeYear, reason: reason || '', status: 'pending' });
        const user = await User.findById(userId).lean();
        await Notification.create({ user_id: userId, for_admin: true, type: 'week4', message: `${user?.name || ''} طلب فك حجز فترة الرواتب لشهر ${monthNum}` });
        res.json({ success: true, message: 'تم إرسال الطلب بنجاح — سيتم إشعارك بالرد' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/my-week4-requests', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const requests = await Week4Request.find({ user_id: userId }).sort({ created_at: -1 }).lean();
        res.json({ success: true, requests: requests.map(r => ({ ...r, id: String(r._id) })) });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.post('/request-swap', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { my_leave_id, target_leave_id, reason } = req.body;
        const myLeave = await Leave.findOne({ _id: my_leave_id, user_id: userId }).lean();
        const targetLeave = await Leave.findById(target_leave_id).lean();
        if (!myLeave || !targetLeave) return res.json({ success: false, message: 'إجازة غير موجودة' });
        const existing = await SwapRequest.findOne({ requester_id: userId, my_leave_id, status: { $in: ['pending_peer', 'pending'] } }).lean();
        if (existing) return res.json({ success: false, message: 'لديك طلب تبديل معلق لهذه الإجازة' });
        await SwapRequest.create({
            requester_id: userId,
            target_user_id: targetLeave.user_id,
            my_leave_id,
            their_leave_id: target_leave_id,
            reason: reason || '',
            target_status: 'pending',
            status: 'pending_peer',
        });
        await Notification.create({ user_id: targetLeave.user_id, message: 'لديك طلب تبديل جديد بانتظار موافقتك', type: 'swap_peer' });
        res.json({ success: true, message: 'تم إرسال الطلب للطرف الآخر أولاً' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/incoming-swap-requests', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const raw = await SwapRequest.find({ target_user_id: userId, status: 'pending_peer' })
            .populate('requester_id', 'name employee_id')
            .populate('my_leave_id', 'month_number week_number')
            .populate('their_leave_id', 'month_number week_number')
            .sort({ created_at: -1 })
            .lean();
        const requests = raw.map((s) => ({
            ...s,
            id: String(s._id),
            requester_name: s.requester_id?.name,
            requester_emp: s.requester_id?.employee_id,
            req_month: s.my_leave_id?.month_number,
            req_week: s.my_leave_id?.week_number,
            tar_month: s.their_leave_id?.month_number,
            tar_week: s.their_leave_id?.week_number,
        }));
        res.json({ success: true, requests });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.post('/swap-requests/respond', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { id, action, note } = req.body;
        const swap = await SwapRequest.findOne({ _id: id, target_user_id: userId }).lean();
        if (!swap) return res.json({ success: false, message: 'الطلب غير موجود' });
        if (action === 'accept') {
            await SwapRequest.updateOne({ _id: id, target_user_id: userId }, { $set: { target_status: 'accepted', target_note: note || '', status: 'pending' } });
            await Notification.create({ user_id: swap.requester_id, message: 'وافق الطرف الآخر على طلب التبديل وتم رفعه للمسؤول', type: 'swap_peer_ok' });
            return res.json({ success: true, message: 'تمت الموافقة ورفع الطلب للمسؤول' });
        }
        await SwapRequest.updateOne({ _id: id, target_user_id: userId }, { $set: { target_status: 'rejected', target_note: note || '', status: 'rejected' } });
        await Notification.create({ user_id: swap.requester_id, message: 'تم رفض طلب التبديل من الطرف الآخر', type: 'swap_peer_no' });
        res.json({ success: true, message: 'تم رفض الطلب' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/leaves-by-employee/:employee_id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const y = await getActiveYearSetting();
        if (y === null) return res.json({ success: false, message: 'لم تُعرَّف سنة نشطة' });
        const target = await User.findOne({ employee_id: req.params.employee_id, is_admin: false }).lean();
        if (!target || String(target._id) === String(userId)) return res.json({ success: false, message: 'الموظف غير موجود' });
        const leaves = await Leave.find({
            user_id: target._id,
            status: { $ne: 'cancelled' },
            $or: [{ year: y }, { year: null }, { year: { $exists: false } }],
        }).sort({ month_number: 1, week_number: 1 }).lean();
        res.json({ success: true, target: { id: String(target._id), name: target.name, employee_id: target.employee_id }, leaves: leaves.map(l => ({ ...l, id: String(l._id) })), activeYear: y });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/my-swap-requests', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const raw = await SwapRequest.find({ $or: [{ requester_id: userId }, { target_user_id: userId }] })
            .populate('requester_id', 'name')
            .populate({ path: 'my_leave_id', select: 'month_number week_number' })
            .populate({ path: 'their_leave_id', select: 'month_number week_number user_id', populate: { path: 'user_id', select: 'name' } })
            .sort({ created_at: -1 })
            .lean();
        const requests = raw.map((sr) => ({
            ...sr,
            id: String(sr._id),
            requester_name: sr.requester_id?.name,
            req_month: sr.my_leave_id?.month_number,
            req_week: sr.my_leave_id?.week_number,
            target_name: sr.their_leave_id?.user_id?.name,
            tar_month: sr.their_leave_id?.month_number,
            tar_week: sr.their_leave_id?.week_number,
        }));
        res.json({ success: true, requests });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/all-leaves-for-swap', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const leavesRaw = await Leave.find({ user_id: { $ne: userId }, status: { $ne: 'cancelled' } })
            .populate('user_id', 'name employee_id is_admin')
            .sort({ month_number: 1, week_number: 1 })
            .lean();
        const leaves = leavesRaw
            .filter(l => !l.user_id?.is_admin)
            .map(l => ({
                ...l,
                id: String(l._id),
                name: l.user_id?.name,
                employee_id: l.user_id?.employee_id,
                user_id: String(l.user_id?._id || l.user_id),
            }));
        res.json({ success: true, leaves });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/occasions', requireAuth, async (req, res) => {
    try {
        const occasions = await Occasion.find({}).sort({ from_date: 1 }).lean();
        res.json({ success: true, occasions: occasions.map(o => ({ ...o, id: String(o._id) })) });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.get('/calendar-data', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const y = await getActiveYearSetting();
        if (y === null) {
            return res.json({ success: true, occasions: [], myLeaves: [], blocked: [], density: [], defaultMax: 3, activeYear: null, noActiveYear: true });
        }

        function occasionOverlapsYear(o) {
            if (!o.from_date) return false;
            const s = new Date(o.from_date);
            const e = new Date(o.to_date || o.from_date);
            const startY = new Date(y, 0, 1);
            const endY = new Date(y, 11, 31, 23, 59, 59);
            return s <= endY && e >= startY;
        }

        const occasions = (await Occasion.find({}).sort({ from_date: 1 }).lean()).filter(occasionOverlapsYear);
        const myLeaves = await Leave.find({ user_id: userId, status: { $ne: 'cancelled' }, $or: [{ year: y }, { year: null }, { year: { $exists: false } }] }).lean();
        const blocked = await BlockedPeriod.find({ $or: [{ year: y }, { year: null }, { year: { $exists: false } }] }).lean();
        const density = await Leave.aggregate([
            { $match: { status: { $ne: 'cancelled' }, $or: [{ year: y }, { year: null }, { year: { $exists: false } }] } },
            { $group: { _id: { month_number: '$month_number', week_number: '$week_number' }, cnt: { $sum: 1 } } },
            { $project: { _id: 0, month_number: '$_id.month_number', week_number: '$_id.week_number', cnt: 1 } },
        ]);
        const maxSetting = await Setting.findOne({ key: 'default_max_per_week' }).lean();
        const defaultMax = maxSetting ? parseInt(maxSetting.value, 10) : 3;
        res.json({
            success: true,
            occasions: occasions.map(o => ({ ...o, id: String(o._id) })),
            myLeaves: myLeaves.map(l => ({ ...l, id: String(l._id) })),
            blocked: blocked.map(b => ({ ...b, id: String(b._id) })),
            density,
            defaultMax,
            activeYear: y,
        });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.post('/change-password', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { current_password, new_password } = req.body;
        const user = await User.findById(userId).lean();
        if (!user || String(user.password) !== String(current_password)) return res.json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
        if (!new_password || String(new_password).trim().length < 4) return res.json({ success: false, message: 'كلمة المرور الجديدة قصيرة' });
        await User.updateOne({ _id: userId }, { $set: { password: String(new_password).trim() } });
        res.json({ success: true, message: 'تم تغيير كلمة المرور' });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

function settingPath(rel) {
    if (!rel || typeof rel !== 'string') return null;
    const t = rel.trim();
    if (!t.startsWith('/')) return null;
    const full = path.join(__dirname, '..', 'public', t.replace(/^\//, ''));
    return fs.existsSync(full) ? full : null;
}

router.post('/profile/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, message: 'لم يتم اختيار ملف' });
        const url = '/uploads/avatars/' + req.file.filename;
        await User.updateOne({ _id: req.session.user.id }, { $set: { avatar_url: url } });
        req.session.user.avatar_url = url;
        res.json({ success: true, avatar_url: url });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.post('/profile/theme', requireAuth, async (req, res) => {
    try {
        const { accent_color } = req.body;
        const hex = String(accent_color || '').trim();
        if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return res.json({ success: false, message: 'لون غير صالح (استخدم #RRGGBB)' });
        await User.updateOne({ _id: req.session.user.id }, { $set: { accent_color: hex } });
        req.session.user.accent_color = hex;
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

router.get('/leave-report', requireAuth, async (req, res) => {
    try {
        const lang = req.query.lang === 'en' ? 'en' : 'ar';
        const userId = req.session.user.id;
        const user = await User.findById(userId).lean();
        const y = await getActiveYearSetting();
        if (y === null) {
            const msg = lang === 'en' ? 'No active year is set.' : 'لم يتم تعيين سنة نشطة.';
            return res.status(400).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report</title></head><body><p>${escapeHtml(msg)}</p></body></html>`);
        }
        const logoRow = await Setting.findOne({ key: 'site_logo' }).lean();
        const logoUrl = logoRow && logoRow.value ? String(logoRow.value).trim() : '';
        const leaves = await Leave.find({ user_id: userId, status: { $ne: 'cancelled' }, $or: [{ year: y }, { year: null }, { year: { $exists: false } }] })
            .sort({ month_number: 1, week_number: 1, start_date: 1 })
            .lean();
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
        const logoBlock = logoUrl ? `<div class="logo-wrap"><img src="${escapeHtml(logoUrl)}" alt="Logo" class="logo-img"></div>` : '';
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
        const user = await User.findById(userId).lean();
        const y = await getActiveYearSetting();
        if (y === null) return res.json({ success: false, message: 'لم يتم تعيين سنة نشطة' });
        const leaves = await Leave.find({ user_id: userId, status: { $ne: 'cancelled' }, $or: [{ year: y }, { year: null }, { year: { $exists: false } }] })
            .sort({ month_number: 1, week_number: 1 })
            .lean();
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('اجازاتي');
        ws.views = [{ rightToLeft: true }];
        const logoFull = settingPath((await Setting.findOne({ key: 'site_logo' }).lean())?.value || '');
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

router.get('/notifications', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notifications = await Notification.find({ user_id: userId, for_admin: false }).sort({ created_at: -1 }).limit(20).lean();
        const unread = await Notification.countDocuments({ user_id: userId, for_admin: false, is_read: false });
        res.json({ success: true, notifications: notifications.map(n => ({ ...n, id: String(n._id) })), unread });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

router.post('/notifications/read-all', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        await Notification.updateMany({ user_id: userId, for_admin: false }, { $set: { is_read: true } });
        res.json({ success: true });
    } catch (e) { res.json({ success: false, message: e.message }); }
});

module.exports = router;
