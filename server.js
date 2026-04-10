require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { connectMongo } = require('./database/mongo');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'leave-system-secret-2024';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Create uploads folders if not exists (branding/avatars only — DB is now external)
['public/uploads/branding', 'public/uploads/avatars'].forEach((p) => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Routes
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const employeeRoutes = require('./routes/employee');

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/employee', employeeRoutes);

// Home route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

async function start() {
    try {
        await connectMongo();
        console.log('Connected to MongoDB successfully');
        app.listen(PORT, () => {
            console.log('Server running at http://localhost:' + PORT);
        });
    } catch (err) {
        console.error('Failed to connect to MongoDB:', err.message);
        process.exit(1);
    }
}

start();
