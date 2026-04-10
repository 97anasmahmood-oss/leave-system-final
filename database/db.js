const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const primaryDbPath = path.join(__dirname, 'leave_system.db');
const fallbackDbPath = path.join(__dirname, 'leaves.db');
const dbPath = fs.existsSync(primaryDbPath) ? primaryDbPath : fallbackDbPath;
const db = new Database(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        annual_leave_weeks INTEGER DEFAULT 3,
        carried_over_days INTEGER DEFAULT 0,
        allow_week4 INTEGER DEFAULT 0,
        admin_notes TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS leaves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        week_number INTEGER,
        month_number INTEGER,
        year INTEGER DEFAULT 2026,
        start_date TEXT,
        end_date TEXT,
        status TEXT DEFAULT 'approved',
        employee_note TEXT DEFAULT '',
        cancel_reason TEXT DEFAULT '',
        cancelled_by TEXT DEFAULT '',
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS blocked_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT DEFAULT 'week',
        month_number INTEGER,
        week_number INTEGER,
        year INTEGER DEFAULT 2026,
        day_date TEXT,
        reason TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS occasions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        from_date TEXT,
        to_date TEXT,
        icon TEXT DEFAULT '🎉',
        color TEXT DEFAULT '#e74c3c',
        type TEXT DEFAULT 'occasion'
    );

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS week4_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        month_number INTEGER,
        year INTEGER DEFAULT 2026,
        reason TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        admin_note TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        for_admin INTEGER DEFAULT 0,
        message TEXT,
        type TEXT DEFAULT 'info',
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS swap_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        requester_id INTEGER,
        target_user_id INTEGER,
        my_leave_id INTEGER,
        their_leave_id INTEGER,
        reason TEXT DEFAULT '',
        target_status TEXT DEFAULT 'pending',
        target_note TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        admin_note TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (requester_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS week_capacity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year INTEGER,
        month_number INTEGER,
        week_number INTEGER,
        max_employees INTEGER DEFAULT 3
    );

    CREATE TABLE IF NOT EXISTS week4_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        year INTEGER,
        month_number INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, year, month_number)
    );
`);

const migrations = [
    `ALTER TABLE users ADD COLUMN admin_notes TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN allow_week4 INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN carried_over_days INTEGER DEFAULT 0`,
    `ALTER TABLE leaves ADD COLUMN employee_note TEXT DEFAULT ''`,
    `ALTER TABLE leaves ADD COLUMN cancel_reason TEXT DEFAULT ''`,
    `ALTER TABLE leaves ADD COLUMN cancelled_by TEXT DEFAULT ''`,
    `ALTER TABLE leaves ADD COLUMN year INTEGER DEFAULT 2026`,
    `ALTER TABLE leaves ADD COLUMN leave_unit TEXT DEFAULT 'week'`,
    `ALTER TABLE leaves ADD COLUMN days_count INTEGER DEFAULT 5`,
    `ALTER TABLE occasions ADD COLUMN icon TEXT DEFAULT '🎉'`,
    `ALTER TABLE occasions ADD COLUMN color TEXT DEFAULT '#e74c3c'`,
    `ALTER TABLE occasions ADD COLUMN type TEXT DEFAULT 'occasion'`,
    `ALTER TABLE week4_requests ADD COLUMN month_number INTEGER`,
    `ALTER TABLE week4_requests ADD COLUMN year INTEGER DEFAULT 2026`,
    `ALTER TABLE swap_requests ADD COLUMN target_user_id INTEGER`,
    `ALTER TABLE swap_requests ADD COLUMN target_status TEXT DEFAULT 'pending'`,
    `ALTER TABLE swap_requests ADD COLUMN target_note TEXT DEFAULT ''`,
    `ALTER TABLE leaves ADD COLUMN carried_days_used INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT ''`,
    `ALTER TABLE users ADD COLUMN accent_color TEXT DEFAULT '#B22234'`,
];
migrations.forEach(sql => { try { db.exec(sql); } catch(e) {} });

// migrate leave_swap_requests -> swap_requests if old table exists
try {
    db.exec(`INSERT OR IGNORE INTO swap_requests (id,requester_id,my_leave_id,their_leave_id,reason,status,admin_note,created_at)
             SELECT id,requester_id,my_leave_id,their_leave_id,reason,status,admin_note,created_at FROM leave_swap_requests`);
} catch(e) {}

try { db.prepare(`INSERT OR IGNORE INTO users (employee_id,name,password,is_admin,annual_leave_weeks) VALUES ('admin','المسؤول','admin@2024',1,0)`).run(); } catch(e) {}
try { db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES ('active_year','2026')`).run(); } catch(e) {}
try { db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES ('default_max_per_week','3')`).run(); } catch(e) {}

module.exports = db;