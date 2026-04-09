(function () {
    const DICT = {
        login: {
            ar: {
                empLabel: 'رقم الموظف',
                empPh: 'أدخل رقم الموظف',
                pwdLabel: 'كلمة المرور',
                pwdPh: 'أدخل كلمة المرور',
                btn: 'تسجيل الدخول',
                errNet: 'خطأ في الاتصال بالخادم',
                errCred: 'الرجاء إدخال رقم الموظف وكلمة المرور',
                langBtn: 'English',
            },
            en: {
                empLabel: 'Employee ID',
                empPh: 'Enter employee ID',
                pwdLabel: 'Password',
                pwdPh: 'Enter password',
                btn: 'Sign in',
                errNet: 'Could not reach the server',
                errCred: 'Please enter employee ID and password',
                langBtn: 'العربية',
            },
        },
        employee: {
            ar: {
                portal: 'بوابة الموظف',
                activeY: 'السنة النشطة',
                notActive: 'غير معتمدة بعد',
                pdf: '🖨️ PDF',
                logout: 'خروج',
                langBtn: 'English',
                tabHome: '🏠 الرئيسية',
                tabReg: '📅 تسجيل إجازة',
                tabMine: '📋 إجازاتي',
                tabSwap: '🔄 طلب تبديل',
                tabCal: '🗓️ التقويم',
                tabSet: '⚙️ الإعدادات',
                statWeek: 'حصة الأسابيع (بالأيام)',
                statUsed: 'أيام مخصومة من الحصة',
                statRem: 'أيام متبقّية',
                statCarry: 'أيام مدورة',
                nextLeave: '⏳ أقرب إجازة قادمة',
                notifTitle: '🔔 الإشعارات الأخيرة',
                pwdTitle: '🔐 تغيير كلمة المرور',
                curPwd: 'كلمة المرور الحالية',
                newPwd: 'كلمة المرور الجديدة',
                savePwd: '💾 حفظ',
                lookTitle: '🎨 المظهر الشخصي',
                uploadAvatar: '📷 رفع صورة',
                accent: 'لون الواجهة',
                saveColor: '💾 حفظ اللون',
                notifBell: '🔔 الإشعارات',
            },
            en: {
                portal: 'Employee portal',
                activeY: 'Active year',
                notActive: 'Not set yet',
                pdf: '🖨️ PDF',
                logout: 'Logout',
                langBtn: 'العربية',
                tabHome: '🏠 Home',
                tabReg: '📅 Book leave',
                tabMine: '📋 My leaves',
                tabSwap: '🔄 Swap',
                tabCal: '🗓️ Calendar',
                tabSet: '⚙️ Settings',
                statWeek: 'Week allowance (days)',
                statUsed: 'Days used from allowance',
                statRem: 'Days remaining',
                statCarry: 'Carried-over days',
                nextLeave: '⏳ Next leave',
                notifTitle: '🔔 Recent notifications',
                pwdTitle: '🔐 Change password',
                curPwd: 'Current password',
                newPwd: 'New password',
                savePwd: '💾 Save',
                lookTitle: '🎨 Personal look',
                uploadAvatar: '📷 Upload photo',
                accent: 'Accent color',
                saveColor: '💾 Save color',
                notifBell: '🔔 Notifications',
            },
        },
        admin: {
            ar: {
                langBtn: 'English',
                brandTitle: '🖼️ الشعار وواجهة تسجيل الدخول',
                brandLogo: 'شعار النظام (يظهر في تسجيل الدخول والتقارير)',
                brandHero: 'صورة خلفية لصفحة تسجيل الدخول',
                titleAr: 'العنوان (عربي)',
                titleEn: 'العنوان (إنجليزي)',
                subAr: 'الوصف (عربي)',
                subEn: 'الوصف (إنجليزي)',
                saveBrand: '💾 حفظ المظهر',
                brandOk: 'تم حفظ الشعار والواجهة',
            },
            en: {
                langBtn: 'العربية',
                brandTitle: '🖼️ Logo & login page',
                brandLogo: 'Site logo (login & reports)',
                brandHero: 'Login page background image',
                titleAr: 'Title (Arabic)',
                titleEn: 'Title (English)',
                subAr: 'Subtitle (Arabic)',
                subEn: 'Subtitle (English)',
                saveBrand: '💾 Save branding',
                brandOk: 'Branding saved',
            },
        },
    };

    function get() {
        return localStorage.getItem('ui_lang') || 'ar';
    }
    function set(lang) {
        if (lang !== 'ar' && lang !== 'en') return;
        localStorage.setItem('ui_lang', lang);
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    }
    function t(page, key) {
        const lang = get();
        const p = DICT[page];
        if (!p) return key;
        return (p[lang] && p[lang][key]) || (p.ar && p.ar[key]) || key;
    }
    window.UI_LANG = { get, set, t, DICT };
})();
