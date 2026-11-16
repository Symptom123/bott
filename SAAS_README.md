\
]# KnightBot SaaS Platform

A multi-user WhatsApp bot platform with web dashboard, super admin panel, and per-user bot sessions.

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install --legacy-peer-deps
```

### 2. Start the SaaS server
```bash
node server.js
# or
npm run start:saas
```

### 3. Open browser
```
http://localhost:3000
```

---

## 🔑 Default Admin Credentials
| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | `admin123` |

> ⚠️ **Change the admin password immediately after first login!**

---

## 📋 How It Works

### For Users:
1. Go to `http://localhost:3000/register` and create an account
2. Wait for the super admin to **activate** your account
3. Login at `http://localhost:3000/dashboard`
4. Set your WhatsApp phone number (with country code, no `+`)
5. Click **▶ Start Bot**
6. A **pairing code** will appear — enter it in WhatsApp:
   - Open WhatsApp → Settings → Linked Devices → Link a Device → "Link with phone number"
7. Your bot is now connected! ✅

### For Super Admin:
1. Login at `http://localhost:3000/dashboard`
2. Click **"Open Admin Panel"**
3. See all registered users
4. **Activate** users to allow them to use the bot
5. **Deactivate** users to revoke access (their bot is stopped)
6. **Delete** users permanently
7. View real-time bot logs per user

---

## 🏗️ Architecture

```
server.js               ← Express API + Socket.IO server
lib/botSessionManager.js ← Manages one Baileys socket per user
lib/userStore.js        ← Per-user message store
sessions/<username>/    ← Per-user WhatsApp session files
data/users.json         ← User database
public/                 ← Web frontend
  index.html            ← Landing page
  register.html         ← Registration
  dashboard.html        ← User bot portal
  admin.html            ← Super admin panel
```

---

## 📡 API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login, get JWT token |

### User (requires login)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/user/me` | Get profile + bot status |
| GET | `/api/user/status` | Bot status |
| GET | `/api/user/logs` | Console logs |
| POST | `/api/user/bot/start` | Start your bot |
| POST | `/api/user/bot/stop` | Stop your bot |
| POST | `/api/user/update-phone` | Set phone number |
| POST | `/api/user/change-password` | Change password |

### Admin (requires superadmin)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List all users |
| GET | `/api/admin/stats` | Platform statistics |
| POST | `/api/admin/activate` | Activate user |
| POST | `/api/admin/deactivate` | Deactivate user + stop bot |
| DELETE | `/api/admin/user/:username` | Delete user |
| GET | `/api/admin/logs/:username` | View user's bot logs |

---

## ⚙️ Environment Variables

Create a `.env` file (optional):

```env
PORT=3000
JWT_SECRET=your-super-secret-key-change-this
```

---

## 🛡️ Security Notes

- Passwords are SHA-256 hashed with a secret salt
- JWT tokens are HMAC-SHA256 signed
- Each user's bot session is completely isolated
- Super admin can deactivate any user instantly (stops their bot)
- New users **cannot** login until admin activates them

---

## 🤖 Bot Commands (after connecting)

| Command | Description |
|---------|-------------|
| `.menu` / `.help` | Show all commands |
| `.ai <question>` | Ask AI (GPT/Gemini) |
| `.play <song>` | Download & send music |
| `.video <query>` | Download YouTube video |
| `.tiktok <url>` | Download TikTok |
| `.ig <url>` | Download Instagram |
| `.vv` (reply) | Reveal view-once media |
| `.sticker` (reply) | Make sticker |
| `.kick @user` | Kick from group |
| `.tagall` | Tag all group members |

---

*Built by **MR UNIQUE HACKER** · KnightBot v2.3.0*
