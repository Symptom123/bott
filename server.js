/**
 * Symptom Bot Platform - Backend API Server
 * Multi-session WhatsApp bot management system
 */

require('./settings')
const express = require('express')
const http = require('http')
const { Server: SocketIOServer } = require('socket.io')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const app = express()
const httpServer = http.createServer(app)
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } })

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))

// ─── Data paths ───────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const SESSIONS_DIR = path.join(__dirname, 'sessions')

// Ensure dirs exist
;[DATA_DIR, SESSIONS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) })

// ─── Simple JWT-like token (HMAC SHA256, no external dep needed) ──────────────
const SECRET = process.env.JWT_SECRET || 'Symptom Bot-saas-secret-2024-change-me'

function signToken(payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
    return `${data}.${sig}`
}

function verifyToken(token) {
    if (!token) return null
    const [data, sig] = (token || '').split('.')
    if (!data || !sig) return null
    const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
    if (sig !== expected) return null
    try { return JSON.parse(Buffer.from(data, 'base64url').toString()) } catch { return null }
}

// ─── User DB helpers ──────────────────────────────────────────────────────────
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch { return {} }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
}

function hashPassword(pw) {
    return crypto.createHash('sha256').update(pw + SECRET).digest('hex')
}

// Bootstrap super admin if not exists
;(function bootstrapAdmin() {
    const users = loadUsers()
    if (!users['admin']) {
        users['admin'] = {
            username: 'admin',
            password: hashPassword('admin123'),
            role: 'superadmin',
            email: 'admin@symptombot.com',
            active: true,
            phoneNumber: '',
            createdAt: new Date().toISOString(),
            botActive: false,
        }
        saveUsers(users)
        console.log('✅ Super admin created: username=admin, password=admin123')
        console.log('⚠️  Change the admin password immediately after first login!')
    }
})()

// ─── Auth middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '')
    const payload = verifyToken(token)
    if (!payload) return res.status(401).json({ error: 'Unauthorized' })
    const users = loadUsers()
    const user = users[payload.username]
    if (!user || (!user.active && user.role !== 'superadmin')) {
        return res.status(403).json({ error: 'Account inactive or not found' })
    }
    req.user = { ...user, username: payload.username }
    next()
}

function adminMiddleware(req, res, next) {
    if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Admin access required' })
    next()
}

// ─── Bot session manager ──────────────────────────────────────────────────────
const { BotSessionManager } = require('./lib/botSessionManager')
const sessionManager = new BotSessionManager(io)

// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
    const { username, password, email, phoneNumber } = req.body
    if (!username || !password || !email) return res.status(400).json({ error: 'username, password, email required' })
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-20 alphanumeric chars' })
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

    const users = loadUsers()
    if (users[username]) return res.status(409).json({ error: 'Username already taken' })

    // Check if email already used
    const emailUsed = Object.values(users).some(u => u.email === email)
    if (emailUsed) return res.status(409).json({ error: 'Email already registered' })

    users[username] = {
        username,
        password: hashPassword(password),
        email,
        phoneNumber: (phoneNumber || '').replace(/[^0-9]/g, ''),
        role: 'user',
        active: false, // Must be activated by admin
        botActive: false,
        createdAt: new Date().toISOString(),
        logs: [],
    }
    saveUsers(users)
    res.json({ message: 'Registration successful! Wait for admin activation.' })
})

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body
    if (!username || !password) return res.status(400).json({ error: 'username and password required' })

    const users = loadUsers()
    const user = users[username]
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    if (user.password !== hashPassword(password)) return res.status(401).json({ error: 'Invalid credentials' })
    if (!user.active && user.role !== 'superadmin') return res.status(403).json({ error: 'Account not yet activated by admin' })

    const token = signToken({ username, role: user.role })
    res.json({ token, username, role: user.role, message: 'Login successful' })
})

// ─── User routes ─────────────────────────────────────────────────────────────
app.get('/api/user/me', authMiddleware, (req, res) => {
    const { password, ...safe } = req.user
    const status = sessionManager.getStatus(req.user.username)
    res.json({ ...safe, botStatus: status })
})

app.post('/api/user/update-phone', authMiddleware, (req, res) => {
    const { phoneNumber } = req.body
    if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })
    const cleaned = phoneNumber.replace(/[^0-9]/g, '')
    const users = loadUsers()
    users[req.user.username].phoneNumber = cleaned
    saveUsers(users)
    res.json({ message: 'Phone number updated', phoneNumber: cleaned })
})

app.post('/api/user/change-password', authMiddleware, (req, res) => {
    const { currentPassword, newPassword } = req.body
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' })
    const users = loadUsers()
    const user = users[req.user.username]
    if (user.password !== hashPassword(currentPassword)) return res.status(401).json({ error: 'Current password incorrect' })
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' })
    users[req.user.username].password = hashPassword(newPassword)
    saveUsers(users)
    res.json({ message: 'Password changed successfully' })
})

app.get('/api/user/status', authMiddleware, (req, res) => {
    const users = loadUsers()
    const user = users[req.user.username] || {}
    const status = sessionManager.getStatus(req.user.username)
    res.json({ ...status, phoneNumber: user.phoneNumber || status.phone })
})

app.get('/api/user/logs', authMiddleware, (req, res) => {
    const logs = sessionManager.getLogs(req.user.username)
    res.json({ logs })
})

app.post('/api/user/bot/start', authMiddleware, async (req, res) => {
    const users = loadUsers()
    const user = users[req.user.username]
    if (!user) return res.status(404).json({ error: 'User not found' })

    const rawPhone = req.body?.phoneNumber || user.phoneNumber
    const phone = String(rawPhone || '').replace(/[^0-9]/g, '')
    if (!phone || phone.length < 8) {
        return res.status(400).json({ error: 'Please enter a valid WhatsApp phone number (with country code, e.g. 237652673304)' })
    }

    if (user.phoneNumber !== phone) {
        user.phoneNumber = phone
        saveUsers(users)
    }

    if (!user.active && user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Account not yet activated by admin' })
    }

    try {
        const result = await sessionManager.startSession(req.user.username, phone)
        res.json({ ...result, phoneNumber: phone })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.post('/api/user/bot/stop', authMiddleware, async (req, res) => {
    try {
        await sessionManager.stopSession(req.user.username)
        res.json({ message: 'Bot stopped' })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.post('/api/user/bot/reset', authMiddleware, async (req, res) => {
    try {
        const result = await sessionManager.resetSession(req.user.username)
        res.json(result)
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get('/api/user/bot/pairing-code', authMiddleware, (req, res) => {
    const code = sessionManager.getPairingCode(req.user.username)
    const qr = sessionManager.getQRCode(req.user.username)
    const status = sessionManager.getStatus(req.user.username)
    res.json({ pairingCode: code, qrCode: qr, status: status.status })
})

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadUsers()
    const safeUsers = Object.entries(users).map(([username, u]) => {
        const { password, ...safe } = u
        return { ...safe, username, botStatus: sessionManager.getStatus(username) }
    })
    res.json({ users: safeUsers, total: safeUsers.length })
})

app.post('/api/admin/activate', authMiddleware, adminMiddleware, (req, res) => {
    const { username } = req.body
    const users = loadUsers()
    if (!users[username]) return res.status(404).json({ error: 'User not found' })
    users[username].active = true
    saveUsers(users)
    io.to(`user:${username}`).emit('account-activated')
    res.json({ message: `${username} activated` })
})

app.post('/api/admin/deactivate', authMiddleware, adminMiddleware, async (req, res) => {
    const { username } = req.body
    const users = loadUsers()
    if (!users[username]) return res.status(404).json({ error: 'User not found' })
    users[username].active = false
    saveUsers(users)
    // Stop their bot session if running
    await sessionManager.stopSession(username).catch(() => {})
    io.to(`user:${username}`).emit('account-deactivated')
    res.json({ message: `${username} deactivated` })
})

app.delete('/api/admin/user/:username', authMiddleware, adminMiddleware, async (req, res) => {
    const { username } = req.params
    if (username === 'admin') return res.status(400).json({ error: 'Cannot delete super admin' })
    const users = loadUsers()
    if (!users[username]) return res.status(404).json({ error: 'User not found' })
    await sessionManager.stopSession(username).catch(() => {})
    delete users[username]
    saveUsers(users)
    res.json({ message: `${username} deleted` })
})

app.post('/api/admin/bot/stop/:username', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        await sessionManager.stopSession(req.params.username)
        res.json({ message: `Bot stopped for ${req.params.username}` })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get('/api/admin/logs/:username', authMiddleware, adminMiddleware, (req, res) => {
    const logs = sessionManager.getLogs(req.params.username)
    res.json({ logs })
})

app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    const users = loadUsers()
    const total = Object.keys(users).length
    const active = Object.values(users).filter(u => u.active).length
    const botsRunning = sessionManager.getActiveSessions().length
    res.json({ totalUsers: total, activeUsers: active, botsRunning, uptime: process.uptime() })
})

// ─── Socket.IO for real-time updates ─────────────────────────────────────────
io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    const payload = verifyToken(token)
    if (!payload) return next(new Error('Unauthorized'))
    const users = loadUsers()
    if (!users[payload.username]) return next(new Error('User not found'))
    socket.username = payload.username
    socket.role = payload.role
    next()
})

io.on('connection', (socket) => {
    socket.join(`user:${socket.username}`)
    if (socket.role === 'superadmin') socket.join('admins')

    socket.on('disconnect', () => {})
})

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')))
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')))
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')))
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
httpServer.listen(PORT, () => {
    console.log(`\n🚀 Symptom Bot Platform running at http://localhost:${PORT}`)
    console.log(`👑 Admin panel: http://localhost:${PORT}/admin`)
    console.log(`📊 Dashboard:   http://localhost:${PORT}/dashboard`)
    console.log(`🔑 Default login: admin / admin123\n`)
})

module.exports = { app, io }
