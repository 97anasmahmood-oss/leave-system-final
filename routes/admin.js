const express = require('express');
const router = express.Router();
const db = require('../database/db');
const multer = require('multer');
const ExcelJS = require('exceljs');
const path = require('path');
const upload = multer({ dest: 'uploads/' });
const fs = require('fs');

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
router.get('/employees', isAdmin, (req, res) => {
    const employees = db.prepare('SELECT * FROM users WHERE is_admin=0 ORDER BY name').all();
    res.json({ success: true, employees });
});

router.post('/employees/add', isAdmin, (req, res) => {
    const { employee_id, name, password, annual_leave_weeks, carried_over_days, allow_week4 } = req.body;
    try {
        db.prepare('INSERT INTO users (employee_id,name,password,annual_leave_weeks,carried_over_days,allow_week4) VALUES (?,?,?,?,?,?)')
            .run(employee_id, name, password, annual_leave_weeks || 3, carried_over_days || 0, allow_week4 || 0);
        db.prepare(`INSERT INTO notifications (for_admin,message,type) VALUES (1,?,?)`).run(`تم إضافة موظف جديد: ${name}`, 'info');
        res.json({ success: true, message: 'تم إضافة الموظف بنجاح' });
    } catch(e) {
        res.json({ success: false, message: 'رقم الموظف مستخدم مسبقاً' });
    }
});

router.post('/employees/update', isAdmin, (req, res) => {
    const { id, name, password, annual_leave_weeks, carried_over_days, allow_week4 } = req.body;
    if (password && password.trim() !== '') {
        db.prepare('UPDATE users SET name=?,password=?,annual_leave_weeks=?,carried_over_days=?,allow_week4=? WHERE id=?')
            .run(name, password, annual_leave_weeks, carried_over_days || 0, allow_week4 || 0, id);
    } else {
        db.prepare('UPDATE users SET name=?,annual_leave_weeks=?,carried_over_days=?,allow_week4=? WHERE id=?')
            .run(name, annual_leave_weeks, carried_over_days || 0, allow_week4 || 0, id);
    }
    res.json({ success: true, message: 'تم تحديث بيانات الموظف' });
});

router.post('/employees/delete', isAdmin, (req, res) => {
    const { id } = req.body;
    db.prepare('DELETE FROM leaves WHERE user_id=?').run(id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    res.json({ success: true, message: 'تم حذف الموظف' });
});

router.post('/employees/notes', isAdmin, (req, res) => {
    const { id, admin_notes } = req.body;
    db.prepare('UPDATE users SET admin_notes=? WHERE id=?').run(admin_notes, id);
    res.json({ success: true, message: 'تم حفظ الملاحظات' });
});

router.post('/employees/import', isAdmin, upload.single('file'), async (req, res) => {
    if (!req.file) return res.json({ success: false, message: 'لم يتم رفع ملف' });
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const ws = workbook.worksheets[0];
        let added = 0, skipped = 0;
        ws.eachRow((row, rowNum) => {
            if (rowNum < 4) return;
            const emp_id = cellToString(row.getCell(1).value);
            const password = cellToString(row.getCell(2).value);
            const name = cellToString(row.getCell(3).value);
            if (!emp_id || !name || !password) return;
            try {
                db.prepare('INSERT OR IGNORE INTO users (employee_id,name,password,annual_leave_weeks) VALUES (?,?,?,3)')
                    .run(emp_id, name, password);
                added++;
            } catch(e) { skipped++; }
        });
        fs.unlinkSync(req.file.path);
        res.json({ success: true, message: `تم إضافة ${added} موظف، تخطي ${skipped}` });
    } catch(e) {
        res.json({ success: false, message: 'خطأ في قراءة الملف: ' + e.message });
    }
});

// ===== الإجازات =====
router.get('/leaves', isAdmin, (req, res) => {
    const leaves = db.prepare(`
        SELECT l.*, u.name, u.employee_id FROM leaves l
        JOIN users u ON l.user_id=u.id
        WHERE l.status!='cancelled'
        ORDER BY l.year DESC, l.month_number, l.week_number
    `).all();
    leaves.forEach(l => {
        if (!l.start_date || !l.end_date) {
            const auto = getWeekAutoDates(parseInt(l.year || new Date().getFullYear(), 10), parseInt(l.month_number, 10), parseInt(l.week_number, 10));
            l.start_date = l.start_date || auto.start_date;
            l.end_date = l.end_date || auto.end_date;
        }
    });
    res.json({ success: true, leaves });
});

router.post('/leaves/delete', isAdmin, (req, res) => {
    db.prepare('DELETE FROM leaves WHERE id=?').run(req.body.id);
    res.json({ success: true, message: 'تم حذف الإجازة' });
});

router.post('/leaves/cancel', isAdmin, (req, res) => {
    const { id, cancel_reason } = req.body;
    const leave = db.prepare('SELECT l.*,u.name,u.id as uid FROM leaves l JOIN users u ON l.user_id=u.id WHERE l.id=?').get(id);
    if (!leave) return res.json({ success: false, message: 'الإجازة غير موجودة' });
    db.prepare('UPDATE leaves SET status=?,cancel_reason=?,cancelled_by=? WHERE id=?')
        .run('cancelled', cancel_reason || '', 'admin', id);
    db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)')
        .run(leave.uid, `تم إلغاء إجازتك (شهر ${leave.month_number} — أسبوع ${leave.week_number})${cancel_reason ? ' — السبب: ' + cancel_reason : ''}`, 'cancel');
    res.json({ success: true, message: 'تم إلغاء الإجازة وإشعار الموظف' });
});

// ===== طلبات الأسبوع الرابع =====
router.get('/week4-requests', isAdmin, (req, res) => {
    const requests = db.prepare(`
        SELECT w.*, u.name, u.employee_id FROM week4_requests w
        JOIN users u ON w.user_id=u.id ORDER BY w.created_at DESC
    `).all();
    res.json({ success: true, requests });
});

router.post('/week4-requests/approve', isAdmin, (req, res) => {
    const { id, admin_note } = req.body;
    const req4 = db.prepare('SELECT * FROM week4_requests WHERE id=?').get(id);
    if (!req4) return res.json({ success: false, message: 'الطلب غير موجود' });
    db.prepare('UPDATE week4_requests SET status=?,admin_note=? WHERE id=?').run('approved', admin_note || '', id);
    db.prepare('INSERT OR IGNORE INTO week4_permissions (user_id,year,month_number) VALUES (?,?,?)')
        .run(req4.user_id, req4.year || 2026, req4.month_number);
    db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)')
        .run(req4.user_id, `✅ تمت الموافقة على طلبك لفتح فترة الرواتب لشهر ${req4.month_number}${admin_note ? ' - ' + admin_note : ''}`, 'week4_approved');
    res.json({ success: true, message: 'تمت الموافقة وفتح فترة الرواتب لهذا الشهر فقط' });
});

router.post('/week4-requests/reject', isAdmin, (req, res) => {
    const { id, admin_note } = req.body;
    const req4 = db.prepare('SELECT * FROM week4_requests WHERE id=?').get(id);
    if (!req4) return res.json({ success: false, message: 'الطلب غير موجود' });
    db.prepare('UPDATE week4_requests SET status=?,admin_note=? WHERE id=?').run('rejected', admin_note || '', id);
    db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)')
        .run(req4.user_id, `❌ تم رفض طلبك لفتح فترة الرواتب${admin_note ? ' - ' + admin_note : ''}`, 'week4_rejected');
    res.json({ success: true, message: 'تم رفض الطلب' });
});

router.post('/week4-requests/delete', isAdmin, (req, res) => {
    const { id } = req.body;
    db.prepare('DELETE FROM week4_requests WHERE id=?').run(id);
    res.json({ success: true, message: 'تم حذف الطلب' });
});

// ===== طلبات التبديل =====
router.get('/swap-requests', isAdmin, (req, res) => {
    const requests = db.prepare(`
        SELECT s.*,
            ur.name as requester_name,
            lm.month_number as req_month, lm.week_number as req_week,
            ut.name as target_name,
            lt.month_number as tar_month, lt.week_number as tar_week
        FROM swap_requests s
        JOIN users ur ON s.requester_id=ur.id
        JOIN leaves lm ON s.my_leave_id=lm.id
        JOIN leaves lt ON s.their_leave_id=lt.id
        JOIN users ut ON lt.user_id=ut.id
        WHERE s.target_status='accepted' AND s.status='pending'
        ORDER BY s.created_at DESC
    `).all();
    res.json({ success: true, requests });
});

router.post('/swap-requests/approve', isAdmin, (req, res) => {
    const { id, admin_note } = req.body;
    const swap = db.prepare('SELECT * FROM swap_requests WHERE id=?').get(id);
    if (!swap) return res.json({ success: false, message: 'الطلب غير موجود' });
    if (swap.target_status !== 'accepted' || swap.status !== 'pending') {
        return res.json({ success: false, message: 'لا يمكن الموافقة قبل قبول الطرف الآخر' });
    }

    const myLeave = db.prepare('SELECT * FROM leaves WHERE id=?').get(swap.my_leave_id);
    const theirLeave = db.prepare('SELECT * FROM leaves WHERE id=?').get(swap.their_leave_id);
    if (!myLeave || !theirLeave) return res.json({ success: false, message: 'إجازة غير موجودة' });

    /** تبديل مواعيد الإجازة بين الموظفين مع الإبقاء على صف كل موظف (user_id ثابت لكل سجل) */
    const upd = db.prepare(`UPDATE leaves SET week_number=?, month_number=?, start_date=?, end_date=?, year=?, leave_unit=?, days_count=?, employee_note=?, carried_days_used=?
        WHERE id=? AND user_id=?`);
    const a = myLeave;
    const b = theirLeave;
    const tx = db.transaction(() => {
        upd.run(b.week_number, b.month_number, b.start_date, b.end_date, b.year ?? null,
            b.leave_unit ?? 'week', b.days_count ?? 5, b.employee_note ?? null, b.carried_days_used ?? 0, a.id, a.user_id);
        upd.run(a.week_number, a.month_number, a.start_date, a.end_date, a.year ?? null,
            a.leave_unit ?? 'week', a.days_count ?? 5, a.employee_note ?? null, a.carried_days_used ?? 0, b.id, b.user_id);
        db.prepare('UPDATE swap_requests SET status=?,admin_note=? WHERE id=?').run('approved', admin_note || '', id);
    });
    tx();
    const peerId = swap.target_user_id;
    db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(swap.requester_id, '✅ تمت الموافقة على طلب تبديل إجازتك وتم تطبيق التواريخ', 'swap_approved');
    db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(peerId, '🔄 تم تبديل إجازتك بموافقة الإدارة وتم تطبيق التواريخ', 'swap_approved');
    res.json({ success: true, message: 'تمت الموافقة على التبديل وتم تطبيقه' });
});

router.post('/swap-requests/reject', isAdmin, (req, res) => {
    const { id, admin_note } = req.body;
    const swap = db.prepare('SELECT * FROM swap_requests WHERE id=?').get(id);
    if (!swap) return res.json({ success: false, message: 'الطلب غير موجود' });
    db.prepare('UPDATE swap_requests SET status=?,admin_note=? WHERE id=?').run('rejected', admin_note || '', id);
    db.prepare('INSERT INTO notifications (user_id,message,type) VALUES (?,?,?)').run(swap.requester_id, '❌ تم رفض طلب تبديل إجازتك', 'swap_rejected');
    res.json({ success: true, message: 'تم رفض الطلب' });
});

// ===== الاستثناءات =====
router.get('/blocked', isAdmin, (req, res) => {
    const blocked = db.prepare('SELECT * FROM blocked_periods ORDER BY year DESC, month_number, week_number').all();
    res.json({ success: true, blocked });
});

router.get('/blocked/public', (req, res) => {
    const blocked = db.prepare('SELECT * FROM blocked_periods').all();
    res.json({ success: true, blocked });
});

router.post('/blocked/add', isAdmin, (req, res) => {
    const { type, year, month_number, week_number, day_date, reason } = req.body;
    db.prepare('INSERT INTO blocked_periods (type,year,month_number,week_number,day_date,reason) VALUES (?,?,?,?,?,?)')
        .run(type, year || 2026, month_number || null, week_number || null, day_date || null, reason || '');
    res.json({ success: true, message: 'تم إضافة الاستثناء' });
});

router.post('/blocked/delete', isAdmin, (req, res) => {
    db.prepare('DELETE FROM blocked_periods WHERE id=?').run(req.body.id);
    res.json({ success: true, message: 'تم حذف الاستثناء' });
});

// ===== المناسبات =====
router.get('/occasions', (req, res) => {
    const occasions = db.prepare('SELECT * FROM occasions ORDER BY from_date').all();
    res.json({ success: true, occasions });
});

router.post('/occasions/add', isAdmin, (req, res) => {
    const { name, from_date, to_date, icon, color, type } = req.body;
    db.prepare('INSERT INTO occasions (name,from_date,to_date,icon,color,type) VALUES (?,?,?,?,?,?)')
        .run(name, from_date, to_date, icon || '🎉', color || '#e74c3c', type || 'occasion');
    res.json({ success: true, message: 'تم إضافة المناسبة' });
});

router.post('/occasions/delete', isAdmin, (req, res) => {
    db.prepare('DELETE FROM occasions WHERE id=?').run(req.body.id);
    res.json({ success: true, message: 'تم حذف المناسبة' });
});

// ===== الإعدادات =====
router.get('/settings/year', (req, res) => {
    const s = db.prepare(`SELECT value FROM settings WHERE key='active_year'`).get();
    const raw = s && s.value !== undefined && s.value !== null ? String(s.value).trim() : '';
    const year = raw === '' ? null : raw;
    res.json({ success: true, year });
});

router.post('/settings/year', isAdmin, (req, res) => {
    const raw = req.body.year;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return res.json({ success: false, message: 'الرجاء اختيار السنة النشطة قبل الحفظ' });
    }
    const y = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(y) || y < 2000 || y > 2100) {
        return res.json({ success: false, message: 'سنة غير صالحة' });
    }
    db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('active_year',?)`).run(String(y));
    res.json({ success: true, message: 'تم حفظ السنة النشطة' });
});

router.get('/settings/max-per-week', (req, res) => {
    const s = db.prepare(`SELECT value FROM settings WHERE key='default_max_per_week'`).get();
    res.json({ success: true, max: s ? parseInt(s.value) : 3 });
});

router.post('/settings/max-per-week', isAdmin, (req, res) => {
    const { max } = req.body;
    db.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('default_max_per_week',?)`).run(max?.toString());
    res.json({ success: true, message: 'تم تحديث الحد الأقصى' });
});

router.get('/settings/branding', isAdmin, (req, res) => {
    try {
        const get = (k) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value || '';
        res.json({
            success: true,
            site_logo: get('site_logo'),
            login_hero: get('login_hero'),
            title_ar: get('title_ar'),
            title_en: get('title_en'),
            subtitle_ar: get('subtitle_ar'),
            subtitle_en: get('subtitle_en'),
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/settings/branding', isAdmin, brandUpload.fields([{ name: 'site_logo', maxCount: 1 }, { name: 'login_hero', maxCount: 1 }]), (req, res) => {
    try {
        const { title_ar, title_en, subtitle_ar, subtitle_en } = req.body;
        const set = (k, v) => {
            if (v !== undefined && v !== null) db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, String(v));
        };
        set('title_ar', title_ar);
        set('title_en', title_en);
        set('subtitle_ar', subtitle_ar);
        set('subtitle_en', subtitle_en);
        const files = req.files || {};
        if (files.site_logo && files.site_logo[0]) {
            set('site_logo', '/uploads/branding/' + files.site_logo[0].filename);
        }
        if (files.login_hero && files.login_hero[0]) {
            set('login_hero', '/uploads/branding/' + files.login_hero[0].filename);
        }
        res.json({ success: true, message: 'تم حفظ الشعار والواجهة والعناوين' });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// الحد الأقصى لأسبوع معين
router.get('/week-capacity', isAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM week_capacity').all();
    res.json({ success: true, rows });
});

router.post('/week-capacity/set', isAdmin, (req, res) => {
    const { year, month_number, week_number, max_employees } = req.body;
    const existing = db.prepare('SELECT id FROM week_capacity WHERE year=? AND month_number=? AND week_number=?').get(year, month_number, week_number);
    if (existing) {
        db.prepare('UPDATE week_capacity SET max_employees=? WHERE id=?').run(max_employees, existing.id);
    } else {
        db.prepare('INSERT INTO week_capacity (year,month_number,week_number,max_employees) VALUES (?,?,?,?)').run(year, month_number, week_number, max_employees);
    }
    res.json({ success: true, message: 'تم تحديث السعة' });
});

// ===== الإشعارات =====
router.get('/notifications', isAdmin, (req, res) => {
    const notifications = db.prepare(`SELECT * FROM notifications WHERE for_admin=1 ORDER BY created_at DESC LIMIT 50`).all();
    const unread = db.prepare(`SELECT COUNT(*) as c FROM notifications WHERE for_admin=1 AND is_read=0`).get().c;
    res.json({ success: true, notifications, unread });
});

router.post('/notifications/read-all', isAdmin, (req, res) => {
    db.prepare('UPDATE notifications SET is_read=1 WHERE for_admin=1').run();
    res.json({ success: true });
});

// ===== تفريغ قاعدة البيانات =====
router.post('/clear-db', isAdmin, (req, res) => {
    try {
        db.pragma('foreign_keys = OFF');
        const clearAll = db.transaction(() => {
            db.prepare('DELETE FROM leaves').run();
            db.prepare('DELETE FROM swap_requests').run();
            db.prepare('DELETE FROM week4_requests').run();
            db.prepare('DELETE FROM week4_permissions').run();
            db.prepare('DELETE FROM notifications').run();
            db.prepare('DELETE FROM blocked_periods').run();
            db.prepare('DELETE FROM occasions').run();
            db.prepare('DELETE FROM week_capacity').run();
            db.prepare('DELETE FROM settings').run();
            db.prepare('DELETE FROM users').run();
            db.prepare(`DELETE FROM sqlite_sequence`).run();
            db.prepare(`INSERT INTO users (employee_id,name,password,is_admin,annual_leave_weeks,carried_over_days,allow_week4) VALUES ('admin','المسؤول','admin@2024',1,0,0,0)`).run();
            db.prepare(`INSERT INTO settings (key,value) VALUES ('active_year','2026')`).run();
            db.prepare(`INSERT INTO settings (key,value) VALUES ('default_max_per_week','3')`).run();
        });
        clearAll();
        db.pragma('foreign_keys = ON');
        res.json({ success: true, message: 'تم مسح جميع بيانات النظام بنجاح' });
    } catch (e) {
        try { db.pragma('foreign_keys = ON'); } catch (_) {}
        res.json({ success: false, message: 'فشل مسح البيانات: ' + e.message });
    }
});

// ===== تصدير Excel =====
router.get('/export', isAdmin, async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'نظام الإجازات';
    const monthNames = ['','كانون الثاني','شباط','آذار','نيسان','أيار','حزيران','تموز','آب','أيلول','تشرين الأول','تشرين الثاني','كانون الأول'];
    const activeYear = db.prepare(`SELECT value FROM settings WHERE key='active_year'`).get()?.value || new Date().getFullYear();
    const employees = db.prepare('SELECT * FROM users WHERE is_admin=0 ORDER BY name').all();
    const leaves = db.prepare(`SELECT l.*,u.name,u.employee_id FROM leaves l JOIN users u ON l.user_id=u.id WHERE l.status!='cancelled' ORDER BY u.name,l.month_number,l.week_number`).all();

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
                const has = leaves.some(l => l.user_id === emp.id && parseInt(l.month_number, 10) === m && parseInt(l.week_number, 10) === w);
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
        const empLeaves = leaves.filter(l => l.user_id === emp.id).slice(0, 3).map(l => {
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