const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');
const User = require('../models/User');
const Leave = require('../models/Leave');
const Week4Request = require('../models/Week4Request');
const Week4Permission = require('../models/Week4Permission');
const Notification = require('../models/Notification');
const SwapRequest = require('../models/SwapRequest');
const BlockedPeriod = require('../models/BlockedPeriod');
const Occasion = require('../models/Occasion');
const Setting = require('../models/Setting');
const WeekCapacity = require('../models/WeekCapacity');

const brandDir = path.join(__dirname, '..', 'public', 'uploads', 'branding');
const brandStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(brandDir, { recursive: true });
        cb(null, brandDir);
    },
    filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname || '') || '.png').toLowerCase();
        const safe = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext) ? ext : '.png';
        cb(null, `${file.fieldname}_${Date.now()}${safe}`);
    },
});
const brandUpload = multer({ storage: brandStorage, limits: { fileSize: 5 * 1024 * 1024 } });
const { getWeekAutoDates } = require('../lib/weekUtils');

function cellToString(cellValue) {
    if (cellValue === null || cellValue === undefined) return '';
    if (typeof cellValue === 'object') {
        if (cellValue.text !== undefined) return String(cellValue.text).trim();
        if (cellValue.result !== undefined) return String(cellValue.result).trim();
        if (cellValue.richText) return cellValue.richText.map(p => p.text || '').join('').trim();
    }
    return String(cellValue).trim();
}

function isAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.is_admin) return next();
    res.status(403).json({ success: false, message: 'غير مصرح' });
}

// ===== الموظفون =====
router.get('/employees', isAdmin, async (req, res) => {
    const employees = await User.find({ is_admin: false }).sort({ name: 1 }).lean();
    res.json({ success: true, employees: employees.map(e => ({ ...e, id: String(e._id) })) });
});

router.post('/employees/add', isAdmin, async (req, res) => {
    const { employee_id, name, password, annual_leave_weeks, carried_over_days, allow_week4 } = req.body;
    try {
        await User.create({
            employee_id,
            name,
            password,
            annual_leave_weeks: annual_leave_weeks || 3,
            carried_over_days: carried_over_days || 0,
            allow_week4: !!allow_week4,
            is_admin: false,
        });
        await Notification.create({ for_admin: true, message: `تم إضافة موظف جديد: ${name}`, type: 'info' });
        res.json({ success: true, message: 'تم إضافة الموظف بنجاح' });
    } catch(e) {
        if (e && (e.code === 11000 || String(e.message || '').includes('duplicate'))) {
            return res.json({ success: false, message: 'رقم الموظف مستخدم مسبقاً' });
        }
        res.json({ success: false, message: e.message });
    }
});

router.post('/employees/update', isAdmin, async (req, res) => {
    const { id, name, password, annual_leave_weeks, carried_over_days, allow_week4 } = req.body;
    const upd = {
        name,
        annual_leave_weeks,
        carried_over_days: carried_over_days || 0,
        allow_week4: !!allow_week4,
    };
    if (password && String(password).trim() !== '') upd.password = password;
    await User.findByIdAndUpdate(id, { $set: upd });
    res.json({ success: true, message: 'تم تحديث بيانات الموظف' });
});

router.post('/employees/delete', isAdmin, async (req, res) => {
    const { id } = req.body;
    await Leave.deleteMany({ user_id: id });
    await User.findByIdAndDelete(id);
    res.json({ success: true, message: 'تم حذف الموظف' });
});

router.post('/employees/notes', isAdmin, async (req, res) => {
    const { id, admin_notes } = req.body;
    await User.findByIdAndUpdate(id, { $set: { admin_notes: admin_notes || '' } });
    res.json({ success: true, message: 'تم حفظ الملاحظات' });
});

router.post('/employees/import', isAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) return res.json({ success: false, message: 'لم يتم رفع ملف' });
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const ws = workbook.worksheets[0];
        let added = 0, skipped = 0;
        for (const [rowNum, row] of ws._rows.entries()) {
            if (!row) continue;
            const rn = rowNum + 1;
            if (rn < 4) continue;
            const emp_id = cellToString(row.getCell(1).value);
            const password = cellToString(row.getCell(2).value);
            const name = cellToString(row.getCell(3).value);
            if (!emp_id || !name || !password) continue;
            const exists = await User.findOne({ employee_id: emp_id }).lean();
            if (exists) { skipped++; continue; }
            try {
                await User.create({ employee_id: emp_id, name, password, annual_leave_weeks: 3, is_admin: false });
                added++;
            } catch (e) { skipped++; }
        }
        fs.unlinkSync(req.file.path);
        res.json({ success: true, message: `تم إضافة ${added} موظف، تخطي ${skipped}` });
    } catch(e) {
        res.json({ success: false, message: 'خطأ في قراءة الملف: ' + e.message });
    }
});

// ===== الإجازات =====
router.get('/leaves', isAdmin, async (req, res) => {
    const leavesRaw = await Leave.find({ status: { $ne: 'cancelled' } })
        .populate('user_id', 'name employee_id')
        .sort({ year: -1, month_number: 1, week_number: 1 })
        .lean();
    const leaves = leavesRaw.map((l) => ({
        ...l,
        id: String(l._id),
        user_id: l.user_id?._id ? String(l.user_id._id) : l.user_id,
        name: l.user_id?.name,
        employee_id: l.user_id?.employee_id,
    }));
    leaves.forEach(l => {
        if (!l.start_date || !l.end_date) {
            const auto = getWeekAutoDates(parseInt(l.year || new Date().getFullYear(), 10), parseInt(l.month_number, 10), parseInt(l.week_number, 10));
            l.start_date = l.start_date || auto.start_date;
            l.end_date = l.end_date || auto.end_date;
        }
    });
    res.json({ success: true, leaves });
});

router.post('/leaves/delete', isAdmin, async (req, res) => {
    await Leave.findByIdAndDelete(req.body.id);
    res.json({ success: true, message: 'تم حذف الإجازة' });
});

router.post('/leaves/cancel', isAdmin, async (req, res) => {
    const { id, cancel_reason } = req.body;
    const leave = await Leave.findById(id).populate('user_id', 'name').lean();
    if (!leave) return res.json({ success: false, message: 'الإجازة غير موجودة' });
    await Leave.findByIdAndUpdate(id, { $set: { status: 'cancelled', cancel_reason: cancel_reason || '', cancelled_by: 'admin' } });
    await Notification.create({
        user_id: leave.user_id?._id,
        message: `تم إلغاء إجازتك (شهر ${leave.month_number} — أسبوع ${leave.week_number})${cancel_reason ? ' — السبب: ' + cancel_reason : ''}`,
        type: 'cancel',
        for_admin: false,
    });
    res.json({ success: true, message: 'تم إلغاء الإجازة وإشعار الموظف' });
});

// ===== طلبات الأسبوع الرابع =====
router.get('/week4-requests', isAdmin, async (req, res) => {
    const raw = await Week4Request.find({}).populate('user_id', 'name employee_id').sort({ created_at: -1 }).lean();
    const requests = raw.map((r) => ({
        ...r,
        id: String(r._id),
        user_id: r.user_id?._id ? String(r.user_id._id) : r.user_id,
        name: r.user_id?.name,
        employee_id: r.user_id?.employee_id,
    }));
    res.json({ success: true, requests });
});

router.post('/week4-requests/approve', isAdmin, async (req, res) => {
    const { id, admin_note } = req.body;
    const req4 = await Week4Request.findById(id).lean();
    if (!req4) return res.json({ success: false, message: 'الطلب غير موجود' });
    await Week4Request.findByIdAndUpdate(id, { $set: { status: 'approved', admin_note: admin_note || '' } });
    await Week4Permission.updateOne(
        { user_id: req4.user_id, year: req4.year || 2026, month_number: req4.month_number },
        { $setOnInsert: { user_id: req4.user_id, year: req4.year || 2026, month_number: req4.month_number } },
        { upsert: true }
    );
    await Notification.create({
        user_id: req4.user_id,
        message: `✅ تمت الموافقة على طلبك لفتح فترة الرواتب لشهر ${req4.month_number}${admin_note ? ' - ' + admin_note : ''}`,
        type: 'week4_approved',
    });
    res.json({ success: true, message: 'تمت الموافقة وفتح فترة الرواتب لهذا الشهر فقط' });
});

router.post('/week4-requests/reject', isAdmin, async (req, res) => {
    const { id, admin_note } = req.body;
    const req4 = await Week4Request.findById(id).lean();
    if (!req4) return res.json({ success: false, message: 'الطلب غير موجود' });
    await Week4Request.findByIdAndUpdate(id, { $set: { status: 'rejected', admin_note: admin_note || '' } });
    await Notification.create({
        user_id: req4.user_id,
        message: `❌ تم رفض طلبك لفتح فترة الرواتب${admin_note ? ' - ' + admin_note : ''}`,
        type: 'week4_rejected',
    });
    res.json({ success: true, message: 'تم رفض الطلب' });
});

router.post('/week4-requests/delete', isAdmin, async (req, res) => {
    const { id } = req.body;
    await Week4Request.findByIdAndDelete(id);
    res.json({ success: true, message: 'تم حذف الطلب' });
});

// ===== طلبات التبديل =====
router.get('/swap-requests', isAdmin, async (req, res) => {
    const raw = await SwapRequest.find({ target_status: 'accepted', status: 'pending' })
        .populate('requester_id', 'name')
        .populate({ path: 'my_leave_id', select: 'month_number week_number' })
        .populate({ path: 'their_leave_id', select: 'month_number week_number user_id', populate: { path: 'user_id', select: 'name' } })
        .sort({ created_at: -1 })
        .lean();
    const requests = raw.map((s) => ({
        ...s,
        id: String(s._id),
        requester_name: s.requester_id?.name,
        req_month: s.my_leave_id?.month_number,
        req_week: s.my_leave_id?.week_number,
        target_name: s.their_leave_id?.user_id?.name,
        tar_month: s.their_leave_id?.month_number,
        tar_week: s.their_leave_id?.week_number,
    }));
    res.json({ success: true, requests });
});

router.post('/swap-requests/approve', isAdmin, async (req, res) => {
    const { id, admin_note } = req.body;
    const swap = await SwapRequest.findById(id).lean();
    if (!swap) return res.json({ success: false, message: 'الطلب غير موجود' });
    if (swap.target_status !== 'accepted' || swap.status !== 'pending') {
        return res.json({ success: false, message: 'لا يمكن الموافقة قبل قبول الطرف الآخر' });
    }

    const myLeave = await Leave.findById(swap.my_leave_id).lean();
    const theirLeave = await Leave.findById(swap.their_leave_id).lean();
    if (!myLeave || !theirLeave) return res.json({ success: false, message: 'إجازة غير موجودة' });

    /** تبديل مواعيد الإجازة بين الموظفين مع الإبقاء على صف كل موظف (user_id ثابت لكل سجل) */
    const a = myLeave;
    const b = theirLeave;
    await Promise.all([
        Leave.updateOne(
            { _id: a._id, user_id: a.user_id },
            {
                $set: {
                    week_number: b.week_number,
                    month_number: b.month_number,
                    start_date: b.start_date,
                    end_date: b.end_date,
                    year: b.year ?? null,
                    leave_unit: b.leave_unit ?? 'week',
                    days_count: b.days_count ?? 5,
                    employee_note: b.employee_note ?? null,
                    carried_days_used: b.carried_days_used ?? 0,
                },
            }
        ),
        Leave.updateOne(
            { _id: b._id, user_id: b.user_id },
            {
                $set: {
                    week_number: a.week_number,
                    month_number: a.month_number,
                    start_date: a.start_date,
                    end_date: a.end_date,
                    year: a.year ?? null,
                    leave_unit: a.leave_unit ?? 'week',
                    days_count: a.days_count ?? 5,
                    employee_note: a.employee_note ?? null,
                    carried_days_used: a.carried_days_used ?? 0,
                },
            }
        ),
        SwapRequest.findByIdAndUpdate(id, { $set: { status: 'approved', admin_note: admin_note || '' } }),
    ]);
    const peerId = swap.target_user_id;
    await Notification.create({ user_id: swap.requester_id, message: '✅ تمت الموافقة على طلب تبديل إجازتك وتم تطبيق التواريخ', type: 'swap_approved' });
    await Notification.create({ user_id: peerId, message: '🔄 تم تبديل إجازتك بموافقة الإدارة وتم تطبيق التواريخ', type: 'swap_approved' });
    res.json({ success: true, message: 'تمت الموافقة على التبديل وتم تطبيقه' });
});

router.post('/swap-requests/reject', isAdmin, async (req, res) => {
    const { id, admin_note } = req.body;
    const swap = await SwapRequest.findById(id).lean();
    if (!swap) return res.json({ success: false, message: 'الطلب غير موجود' });
    await SwapRequest.findByIdAndUpdate(id, { $set: { status: 'rejected', admin_note: admin_note || '' } });
    await Notification.create({ user_id: swap.requester_id, message: '❌ تم رفض طلب تبديل إجازتك', type: 'swap_rejected' });
    res.json({ success: true, message: 'تم رفض الطلب' });
});

// ===== الاستثناءات =====
router.get('/blocked', isAdmin, async (req, res) => {
    const blocked = await BlockedPeriod.find({}).sort({ year: -1, month_number: 1, week_number: 1 }).lean();
    res.json({ success: true, blocked: blocked.map(b => ({ ...b, id: String(b._id) })) });
});

router.get('/blocked/public', async (req, res) => {
    const blocked = await BlockedPeriod.find({}).lean();
    res.json({ success: true, blocked: blocked.map(b => ({ ...b, id: String(b._id) })) });
});

router.post('/blocked/add', isAdmin, async (req, res) => {
    const { type, year, month_number, week_number, day_date, reason } = req.body;
    await BlockedPeriod.create({
        type,
        year: year || 2026,
        month_number: month_number || null,
        week_number: week_number || null,
        day_date: day_date || null,
        reason: reason || '',
    });
    res.json({ success: true, message: 'تم إضافة الاستثناء' });
});

router.post('/blocked/delete', isAdmin, async (req, res) => {
    await BlockedPeriod.findByIdAndDelete(req.body.id);
    res.json({ success: true, message: 'تم حذف الاستثناء' });
});

// ===== المناسبات =====
router.get('/occasions', async (req, res) => {
    const occasions = await Occasion.find({}).sort({ from_date: 1 }).lean();
    res.json({ success: true, occasions: occasions.map(o => ({ ...o, id: String(o._id) })) });
});

router.post('/occasions/add', isAdmin, async (req, res) => {
    const { name, from_date, to_date, icon, color, type } = req.body;
    await Occasion.create({ name, from_date, to_date, icon: icon || '🎉', color: color || '#e74c3c', type: type || 'occasion' });
    res.json({ success: true, message: 'تم إضافة المناسبة' });
});

router.post('/occasions/delete', isAdmin, async (req, res) => {
    await Occasion.findByIdAndDelete(req.body.id);
    res.json({ success: true, message: 'تم حذف المناسبة' });
});

// ===== الإعدادات =====
router.get('/settings/year', async (req, res) => {
    const s = await Setting.findOne({ key: 'active_year' }).lean();
    const raw = s && s.value !== undefined && s.value !== null ? String(s.value).trim() : '';
    const year = raw === '' ? null : raw;
    res.json({ success: true, year });
});

router.post('/settings/year', isAdmin, async (req, res) => {
    const raw = req.body.year;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return res.json({ success: false, message: 'الرجاء اختيار السنة النشطة قبل الحفظ' });
    }
    const y = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(y) || y < 2000 || y > 2100) {
        return res.json({ success: false, message: 'سنة غير صالحة' });
    }
    await Setting.updateOne({ key: 'active_year' }, { $set: { key: 'active_year', value: String(y) } }, { upsert: true });
    res.json({ success: true, message: 'تم حفظ السنة النشطة' });
});

router.get('/settings/max-per-week', async (req, res) => {
    const s = await Setting.findOne({ key: 'default_max_per_week' }).lean();
    res.json({ success: true, max: s ? parseInt(s.value, 10) : 3 });
});

router.post('/settings/max-per-week', isAdmin, async (req, res) => {
    const { max } = req.body;
    await Setting.updateOne(
        { key: 'default_max_per_week' },
        { $set: { key: 'default_max_per_week', value: max?.toString() } },
        { upsert: true }
    );
    res.json({ success: true, message: 'تم تحديث الحد الأقصى' });
});

router.get('/settings/branding', isAdmin, async (req, res) => {
    try {
        const get = async (k) => (await Setting.findOne({ key: k }).lean())?.value || '';
        res.json({
            success: true,
            site_logo: await get('site_logo'),
            login_hero: await get('login_hero'),
            title_ar: await get('title_ar'),
            title_en: await get('title_en'),
            subtitle_ar: await get('subtitle_ar'),
            subtitle_en: await get('subtitle_en'),
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/settings/branding', isAdmin, brandUpload.fields([{ name: 'site_logo', maxCount: 1 }, { name: 'login_hero', maxCount: 1 }]), async (req, res) => {
    try {
        const { title_ar, title_en, subtitle_ar, subtitle_en } = req.body;
        const set = async (k, v) => {
            if (v !== undefined && v !== null) await Setting.updateOne({ key: k }, { $set: { key: k, value: String(v) } }, { upsert: true });
        };
        await set('title_ar', title_ar);
        await set('title_en', title_en);
        await set('subtitle_ar', subtitle_ar);
        await set('subtitle_en', subtitle_en);
        const files = req.files || {};
        if (files.site_logo && files.site_logo[0]) {
            await set('site_logo', '/uploads/branding/' + files.site_logo[0].filename);
        }
        if (files.login_hero && files.login_hero[0]) {
            await set('login_hero', '/uploads/branding/' + files.login_hero[0].filename);
        }
        res.json({ success: true, message: 'تم حفظ الشعار والواجهة والعناوين' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// الحد الأقصى لأسبوع معين
router.get('/week-capacity', isAdmin, async (req, res) => {
    const rows = await WeekCapacity.find({}).lean();
    res.json({ success: true, rows: rows.map(r => ({ ...r, id: String(r._id) })) });
});

router.post('/week-capacity/set', isAdmin, async (req, res) => {
    const { year, month_number, week_number, max_employees } = req.body;
    await WeekCapacity.updateOne(
        { year, month_number, week_number },
        { $set: { year, month_number, week_number, max_employees } },
        { upsert: true }
    );
    res.json({ success: true, message: 'تم تحديث السعة' });
});

// ===== الإشعارات =====
router.get('/notifications', isAdmin, async (req, res) => {
    const notifications = await Notification.find({ for_admin: true }).sort({ created_at: -1 }).limit(50).lean();
    const unread = await Notification.countDocuments({ for_admin: true, is_read: false });
    res.json({ success: true, notifications: notifications.map(n => ({ ...n, id: String(n._id) })), unread });
});

router.post('/notifications/read-all', isAdmin, async (req, res) => {
    await Notification.updateMany({ for_admin: true }, { $set: { is_read: true } });
    res.json({ success: true });
});

// ===== تفريغ قاعدة البيانات =====
router.post('/clear-db', isAdmin, async (req, res) => {
    try {
        await Promise.all([
            Leave.deleteMany({}),
            SwapRequest.deleteMany({}),
            Week4Request.deleteMany({}),
            Week4Permission.deleteMany({}),
            Notification.deleteMany({}),
            BlockedPeriod.deleteMany({}),
            Occasion.deleteMany({}),
            WeekCapacity.deleteMany({}),
            Setting.deleteMany({}),
            User.deleteMany({}),
        ]);
        await User.create({
            employee_id: 'admin',
            name: 'المسؤول',
            password: 'admin@2024',
            is_admin: true,
            annual_leave_weeks: 0,
            carried_over_days: 0,
            allow_week4: false,
        });
        await Setting.create({ key: 'active_year', value: '2026' });
        await Setting.create({ key: 'default_max_per_week', value: '3' });
        res.json({ success: true, message: 'تم مسح جميع بيانات النظام بنجاح' });
    } catch (e) {
        res.json({ success: false, message: 'فشل مسح البيانات: ' + e.message });
    }
});

// ===== تصدير Excel =====
router.get('/export', isAdmin, async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'نظام الإجازات';
    const monthNames = ['','كانون الثاني','شباط','آذار','نيسان','أيار','حزيران','تموز','آب','أيلول','تشرين الأول','تشرين الثاني','كانون الأول'];
    const activeYear = (await Setting.findOne({ key: 'active_year' }).lean())?.value || new Date().getFullYear();
    const employeesRaw = await User.find({ is_admin: false }).sort({ name: 1 }).lean();
    const employees = employeesRaw.map(e => ({ ...e, id: String(e._id) }));
    const leavesRaw = await Leave.find({ status: { $ne: 'cancelled' } })
        .populate('user_id', 'name employee_id')
        .sort({ 'user_id.name': 1, month_number: 1, week_number: 1 })
        .lean();
    const leaves = leavesRaw.map((l) => ({
        ...l,
        id: String(l._id),
        user_id: l.user_id?._id ? String(l.user_id._id) : l.user_id,
        name: l.user_id?.name,
        employee_id: l.user_id?.employee_id,
    }));

    // شيت 1: مصفوفة إشارات الصح حسب الشهر/الأسبوع
    const ws1 = workbook.addWorksheet('الملخص');
    ws1.views = [{ rightToLeft: true }];
    const headers = ['رقم الموظف', 'الاسم'];
    for (let m = 1; m <= 12; m++) for (let w = 1; w <= 4; w++) headers.push(`${monthNames[m]}-أ${w}`);
    ws1.addRow(headers);
    ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB22234' } };
    employees.forEach(emp => {
        const row = [emp.employee_id, emp.name];
        for (let m = 1; m <= 12; m++) {
            for (let w = 1; w <= 4; w++) {
                const has = leaves.some(l => String(l.user_id) === String(emp.id) && parseInt(l.month_number, 10) === m && parseInt(l.week_number, 10) === w);
                row.push(has ? '✓' : '');
            }
        }
        ws1.addRow(row);
    });
    ws1.columns.forEach((c, i) => { c.width = i < 2 ? 18 : 12; });

    // شيت 2: 3 إجازات لكل موظف (من-إلى) في نفس السطر
    const ws2 = workbook.addWorksheet('تفاصيل الإجازات');
    ws2.views = [{ rightToLeft: true }];
    ws2.addRow(['رقم الموظف', 'الاسم', 'إجازة 1 (من-إلى)', 'إجازة 2 (من-إلى)', 'إجازة 3 (من-إلى)']);
    ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB22234' } };
    employees.forEach(emp => {
        const empLeaves = leaves.filter(l => String(l.user_id) === String(emp.id)).slice(0, 3).map(l => {
            const auto = (!l.start_date || !l.end_date) ? getWeekAutoDates(parseInt(l.year || activeYear, 10), parseInt(l.month_number, 10), parseInt(l.week_number, 10)) : null;
            const from = l.start_date || auto.start_date;
            const to = l.end_date || auto.end_date;
            return `${monthNames[l.month_number]} أ${l.week_number}: ${from} → ${to}`;
        });
        ws2.addRow([emp.employee_id, emp.name, empLeaves[0] || '-', empLeaves[1] || '-', empLeaves[2] || '-']);
    });
    ws2.columns = [{ width: 14 }, { width: 24 }, { width: 34 }, { width: 34 }, { width: 34 }];

    // شيت 3: تقويم شهري بالأسماء
    const ws3 = workbook.addWorksheet('التقويم');
    ws3.views = [{ rightToLeft: true }];
    ws3.addRow([`التقويم السنوي ${activeYear}`]);
    ws3.getRow(1).font = { bold: true, size: 14 };
    ws3.mergeCells('A1:C1');
    ws3.addRow([]);
    for (let m = 1; m <= 12; m++) {
        const h = ws3.addRow([`${monthNames[m]} (${m})`, 'أسماء المجازين', 'تفصيل الأسابيع']);
        h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB22234' } };
        const monthRows = leaves.filter(l => parseInt(l.month_number, 10) === m);
        const uniqueNames = [...new Set(monthRows.map(l => l.name))];
        const weeksText = [1,2,3,4].map(w => {
            const names = monthRows.filter(l => parseInt(l.week_number, 10) === w).map(l => l.name);
            return `أ${w}: ${names.join(' | ') || '-'}`;
        }).join('  |  ');
        ws3.addRow(['', uniqueNames.join(' | ') || '-', weeksText]);
        ws3.addRow([]);
    }
    ws3.columns = [{ width: 22 }, { width: 50 }, { width: 90 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="leaves_${activeYear}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
});

module.exports = router;