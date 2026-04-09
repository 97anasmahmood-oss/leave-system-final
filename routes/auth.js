const express = require('express');
const router = express.Router();
const db = require('../database/db');

function settingVal(key, fallback = '') {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row && row.value != null && String(row.value).trim() !== '' ? String(row.value).trim() : fallback;
}

router.get('/branding', (req, res) => {
    try {
        res.json({
            success: true,
            site_logo: settingVal('site_logo', ''),
            login_hero: settingVal('login_hero', ''),
            title_ar: settingVal('title_ar', 'مركز الاتصال'),
            title_en: settingVal('title_en', 'Call Center'),
            subtitle_ar: settingVal('subtitle_ar', 'نظام إدارة الإجازات السنوية'),
            subtitle_en: settingVal('subtitle_en', 'Annual Leave Management'),
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/login', (req, res) => {
    const { employee_id, password } = req.body;
    if (!employee_id || !password) {
        return res.json({ success: false, message: 'الرجاء إدخال رقم الموظف وكلمة المرور' });
    }
    const user = db.prepare('SELECT * FROM users WHERE employee_id=?').get(employee_id);
    if (!user || user.password !== password) {
        return res.json({ success: false, message: 'رقم الموظف أو كلمة المرور غير صحيحة' });
    }
    req.session.user = {
        id: user.id,
        employee_id: user.employee_id,
        name: user.name,
        is_admin: user.is_admin,
        annual_leave_weeks: user.annual_leave_weeks,
        carried_over_days: user.carried_over_days || 0,
        allow_week4: user.allow_week4 || 0,
        avatar_url: user.avatar_url || '',
        accent_color: user.accent_color || '#B22234',
    };
    const redirect = user.is_admin ? '/admin.html' : '/employee.html';
    res.json({ success: true, redirect, message: 'تم تسجيل الدخول بنجاح' });
});

router.get('/me', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.json({ success: false, message: 'غير مسجل الدخول' });
    }
    // تحديث بيانات المستخدم من قاعدة البيانات
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
    if (!user) return res.json({ success: false, message: 'المستخدم غير موجود' });
    req.session.user = {
        id: user.id,
        employee_id: user.employee_id,
        name: user.name,
        is_admin: user.is_admin,
        annual_leave_weeks: user.annual_leave_weeks,
        carried_over_days: user.carried_over_days || 0,
        allow_week4: user.allow_week4 || 0,
        avatar_url: user.avatar_url || '',
        accent_color: user.accent_color || '#B22234',
    };
    res.json({ success: true, user: req.session.user });
});

router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

module.exports = router;