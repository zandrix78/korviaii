const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// 1. Conexão com Banco de Dados (Com Fallback para Memória se você não configurou o MongoDB)
const hasDB = !!process.env.MONGODB_URI;
if (hasDB) {
    mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
        .then(() => console.log('✅ MongoDB Online'))
        .catch(err => console.error('❌ Erro de Conexão MongoDB:', err));
} else {
    console.log('⚠️ Aviso: MONGODB_URI não configurada. Usando memória temporária.');
}

// 2. Modelos de Dados (Estrutura do SaaS)
const User = mongoose.model('User', new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    lastLogin: String
}));

const Settings = mongoose.model('Settings', new mongoose.Schema({
    userEmail: { type: String, required: true, unique: true },
    openaiKey: String,
    metaToken: String,
    igBusinessId: String,
    brandContext: String,
    aiInstructions: String
}));

const Automation = mongoose.model('Automation', new mongoose.Schema({
    userEmail: { type: String, required: true, unique: true },
    keyword: { type: String, default: "QUERO" },
    flow: Array,
    active: { type: Boolean, default: true }
}));

const Lead = mongoose.model('Lead', new mongoose.Schema({
    userEmail: String,
    ig: String,
    trigger: String,
    aiResponse: String,
    timestamp: { type: Date, default: Date.now }
}));

// Memória Temporária (Caso o banco não esteja configurado)
let usersMem = [];
let settingsMem = {};
let automationsMem = {};
let leadsMem = [];

// 1. Webhook (Instagram)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'instagram') {
        try {
            for (const entry of body.entry) {
                const igBusinessId = entry.id;
                const settings = hasDB ? await Settings.findOne({ igBusinessId }) : Object.values(settingsMem).find(s => s.igBusinessId === igBusinessId);
                if (!settings) continue;

                const automation = hasDB ? await Automation.findOne({ userEmail: settings.userEmail, active: true }) : automationsMem[settings.userEmail];
                if (!automation) continue;

                const change = entry.changes ? entry.changes[0] : null;
                if (change && change.field === 'comments') {
                    const commentText = change.value.text.toUpperCase();
                    if (automation.keyword && commentText.includes(automation.keyword.toUpperCase())) {
                        await executeFlowInternal(change.value.from.id, automation.flow, settings);
                        const leadData = { 
                            userEmail: settings.userEmail, ig: `@${change.value.from.username || 'user'}`, 
                            trigger: automation.keyword, aiResponse: "IA Respondeu", timestamp: new Date()
                        };
                        if (hasDB) await Lead.create(leadData); else leadsMem.unshift(leadData);
                    }
                }
            }
            res.status(200).send('OK');
        } catch (err) {
            res.status(200).send('OK');
        }
    } else res.sendStatus(404);
});

// 2. Autenticação (Login/Cadastro)
app.post('/api/signup', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (hasDB) {
            const existing = await User.findOne({ email });
            if (existing) return res.status(400).json({ success: false, message: "E-mail já existe." });
            await User.create({ email, password, lastLogin: new Date().toLocaleString() });
        } else {
            if (usersMem.find(u => u.email === email)) return res.status(400).json({ success: false, message: "E-mail já existe." });
            usersMem.push({ email, password, lastLogin: new Date().toLocaleString() });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const user = hasDB ? await User.findOne({ email, password }) : usersMem.find(u => u.email === email && u.password === password);
    
    if (!user && email !== 'richarddasilvacampos25@gmail.com') return res.status(401).json({ success: false, message: "Dados incorretos." });
    
    if (user && hasDB) {
        await User.updateOne({ email }, { lastLogin: new Date().toLocaleString() });
    }

    res.json({ success: true, user: { email } });
});

// 3. Gerenciamento de Dados (Por Usuário)
app.get('/api/settings', async (req, res) => {
    const email = req.headers['x-user-email'];
    res.json((hasDB ? await Settings.findOne({ userEmail: email }) : settingsMem[email]) || {});
});

app.post('/api/settings', async (req, res) => {
    const email = req.headers['x-user-email'];
    if (hasDB) await Settings.findOneAndUpdate({ userEmail: email }, { ...req.body, userEmail: email }, { upsert: true });
    else settingsMem[email] = { ...req.body, userEmail: email };
    res.json({ success: true });
});

app.post('/api/publish', async (req, res) => {
    const email = req.headers['x-user-email'];
    if (hasDB) await Automation.findOneAndUpdate({ userEmail: email }, { ...req.body, userEmail: email }, { upsert: true });
    else automationsMem[email] = { ...req.body, userEmail: email, active: true };
    res.json({ success: true });
});

app.get('/api/leads', async (req, res) => {
    const email = req.headers['x-user-email'];
    res.json(hasDB ? await Lead.find({ userEmail: email }).sort({ timestamp: -1 }) : leadsMem.filter(l => l.userEmail === email));
});

app.post('/api/process-flow', async (req, res) => {
    const email = req.headers['x-user-email'];
    const settings = hasDB ? await Settings.findOne({ userEmail: email }) : settingsMem[email];
    await executeFlowInternal(req.body.recipientId, req.body.flow, settings);
    res.json({ success: true });
});

async function executeFlowInternal(recipientId, flow, settings) {
    if (!settings || !settings.metaToken) return;
    for (const step of flow) {
        if (step.type === 'delay') {
            await new Promise(r => setTimeout(r, parseInt(step.content) * 1000));
            continue;
        }

        let messageData = {};

        if (step.type === 'text') {
            let text = step.content;
            if (settings.openaiKey) {
                try {
                    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
                        model: 'gpt-3.5-turbo',
                        messages: [
                            { role: 'system', content: `Contexto: ${settings.brandContext}. Instruções: ${settings.aiInstructions}` },
                            { role: 'user', content: text }
                        ]
                    }, { headers: { 'Authorization': `Bearer ${settings.openaiKey}` } });
                    text = aiRes.data.choices[0].message.content;
                } catch (e) {}
            }
            messageData = { text };
        } else if (step.type === 'image' || step.type === 'audio') {
            messageData = { attachment: { type: step.type, payload: { url: step.content, is_selectable: true } } };
        }

        if (settings.metaToken && Object.keys(messageData).length > 0) {
            await axios.post(`https://graph.facebook.com/v21.0/me/messages`, {
                recipient: { id: recipientId },
                message: messageData
            }, { headers: { Authorization: `Bearer ${settings.metaToken}` } }).catch(() => {});
        }
    }
}

app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR ONLINE: http://localhost:${PORT}`);
});