const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
// Servir arquivos estáticos da raiz para compatibilidade com as páginas existentes
app.use(express.static(path.join(__dirname)));
// Expõe também a pasta src sob /src caso haja assets lá
app.use('/src', express.static(path.join(__dirname, 'src')));

// armazenamento em memória com persistência simples em arquivos JSON (demo).
// Em produção, troque por um banco de dados real.
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
const usersFile = path.join(dataDir, 'users.json');
const pendingFile = path.join(dataDir, 'pending.json');

function loadJSON(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback;
  } catch (e) {
    console.error('failed to load', file, e.message);
  }
  return fallback;
}
function saveJSON(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('failed to write', file, e.message);
  }
}

const users = loadJSON(usersFile, {});
const pending = loadJSON(pendingFile, {}); // shape: { username: { code, passwordHash, email, expiresAt } }

// transporter Gmail SMTP (use App Password ou OAuth2 em produção)
let transporter = null;
if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS
    }
  });
} else {
  // sem credenciais, usamos um transportador de simulação para não falhar nos testes
  console.warn('GMAIL_USER/GMAIL_PASS não configurados — emails serão logados em vez de enviados.');
  transporter = { sendMail: async (opts) => { console.log('[mail simulated] to=', opts.to, 'text=', opts.text); return Promise.resolve(); } };
}

app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password || !email) return res.status(400).json({ error: 'missing_fields' });

  const u = username.toLowerCase();
  if (users[u]) return res.status(400).json({ error: 'user_exists' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const passwordHash = await bcrypt.hash(password, 10);
  pending[u] = { code, passwordHash, email, expiresAt: Date.now() + 10 * 60 * 1000 };
  // persiste pending
  saveJSON(pendingFile, pending);

  try {
    await transporter.sendMail({
      from: process.env.GMAIL_FROM || process.env.GMAIL_USER,
      to: email,
      subject: 'Código de verificação',
      text: `Seu código de verificação: ${code}`
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('mail error', err);
    // Para facilitar testes locais, tratamos qualquer erro de envio como 'não enviado'
    // mas mantemos o código pendente (não removemos). O servidor retorna OK com
    // um aviso para o cliente. Em produção, prefira falhar ou usar retries/queue.
    return res.json({ ok: true, warning: 'mail_not_sent' });
  }
});

app.post('/api/verify', (req, res) => {
  const { username, code } = req.body || {};
  const u = (username || '').toLowerCase();
  const p = pending[u];
  if (!p || p.expiresAt < Date.now()) return res.status(400).json({ error: 'invalid_or_expired' });
  if (p.code !== code) return res.status(400).json({ error: 'wrong_code' });

  users[u] = { email: p.email, passwordHash: p.passwordHash };
  delete pending[u];
  // persiste dados
  saveJSON(usersFile, users);
  saveJSON(pendingFile, pending);
  return res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = (username || '').toLowerCase();
  const user = users[u];
  if (!user) return res.status(400).json({ error: 'invalid_credentials' });
  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(400).json({ error: 'invalid_credentials' });
  return res.json({ ok: true });
});

// Fallback para aplicações SPA: se não for /api/* e não corresponder a arquivo
// estático, devolve o index.html principal.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  return res.sendFile(path.join(__dirname, 'index.html'));
});

const port = parseInt(process.env.PORT || '3000', 10);
const server = app.listen(port, () => console.log(`Server rodando na porta ${port}`));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Porta ${port} já está em uso. Verifique processos rodando ou altere a variável PORT.`);
    process.exit(1);
  }
  console.error('Server error', err);
  process.exit(1);
});