const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
require('dotenv').config();
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// Banco de Dados Temporário (Em um cenário real, use MongoDB ou SQL)
let users = []; 
let leads = [];
let activeAutomation = {
    keyword: "QUERO",
    flow: []
};
let userSettings = {
    openaiKey: "",
    fbAppId: "",
    metaToken: "",
    igBusinessId: "",
    brandContext: "",
    aiInstructions: ""
};

// 1. Rota de Verificação do Webhook (Necessária para configurar na Meta/Facebook)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        console.log('WEBHOOK_VALIDADO');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// 2. Rota que recebe os eventos do Instagram REAL (Mensagens e Comentários)
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'instagram') {
        try {
            for (const entry of body.entry) {
                const change = entry.changes ? entry.changes[0] : null;
                
                // Verifica se é um comentário e se a palavra-chave bate
                if (change && change.field === 'comments') {
                    const commentText = change.value.text.toUpperCase();
                    const senderId = change.value.from.id;

                    console.log(`Comentário recebido: "${commentText}" de ${senderId}`);

                    if (activeAutomation.keyword && commentText.includes(activeAutomation.keyword.toUpperCase())) {
                        console.log("Palavra-chave detectada! Iniciando fluxo automático...");
                        
                        // Dispara o motor de automação (reaproveitando a lógica interna)
                        await executeFlowInternal(senderId, activeAutomation.flow);
                    }
                }
            }
            res.status(200).send('EVENT_RECEIVED');
        } catch (err) {
            console.error("Erro ao processar Webhook:", err.message);
            res.status(200).send('EVENT_RECEIVED'); // Sempre retorne 200 para o Facebook não desativar seu webhook
        }
    } else {
        res.sendStatus(404);
    }
});

// 3. API de Autenticação (Cadastro e Login)
app.post('/api/signup', (req, res) => {
    const { email, password } = req.body;
    if (users.find(u => u.email === email)) {
        return res.status(400).json({ success: false, message: "E-mail já cadastrado." });
    }
    users.push({ email, password });
    console.log(`Novo usuário cadastrado: ${email}`);
    res.json({ success: true, message: "Conta criada com sucesso!" });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    // Busca o usuário no array (em produção use um banco de dados)
    const user = users.find(u => u.email === email && u.password === password);
    
    if (!user && email !== 'richarddasilvacampos25@gmail.com') {
        return res.status(401).json({ success: false, message: "E-mail ou senha incorretos." });
    }

    console.log(`Usuário logado: ${email}`);
    res.json({ 
        success: true, 
        message: "Conectado ao Backend Korvia",
        user: { email, role: email === 'richarddasilvacampos25@gmail.com' ? 'admin' : 'user' }
    });
});

// 4. API de Configurações
app.get('/api/settings', (req, res) => res.json(userSettings));
app.post('/api/settings', (req, res) => {
    userSettings = { ...userSettings, ...req.body };
    console.log('Configurações atualizadas pelo usuário no painel.');
    res.json({ success: true, settings: userSettings });
});

// API para Publicar Automação (Envia do Painel para o Cérebro do Servidor)
app.post('/api/publish', (req, res) => {
    const { keyword, flow } = req.body;
    activeAutomation.keyword = keyword;
    activeAutomation.flow = flow;
    console.log(`Automação publicada no servidor! Keyword: ${keyword}`);
    res.json({ success: true });
});

// 6. Motor de Execução de Automação (A ponte para OpenAI e Meta)
app.post('/api/process-flow', async (req, res) => {
    const { recipientId, flow, isSimulation } = req.body;
    await executeFlowInternal(recipientId, flow);
    res.json({ success: true });
});

// Função interna que faz o trabalho pesado de falar com OpenAI e Meta
async function executeFlowInternal(recipientId, flow) {
    const settings = userSettings;
    for (const step of flow) {
        if (step.type === 'delay') {
            await new Promise(r => setTimeout(r, parseInt(step.content) * 1000));
            continue;
        }
        let text = step.content;
        if (step.type === 'text' && settings.openaiKey) {
            const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: `IA Korvia. Contexto: ${settings.brandContext}. Instruções: ${settings.aiInstructions}` },
                    { role: 'user', content: `Personalize para o Direct: "${text}"` }
                ]
            }, { headers: { 'Authorization': `Bearer ${settings.openaiKey}` } });
            text = aiResponse.data.choices[0].message.content;
        }
        if (settings.metaToken && settings.igBusinessId) {
            await axios.post(`https://graph.facebook.com/v21.0/${settings.igBusinessId}/messages`, {
                recipient: { id: recipientId },
                message: step.type === 'text' ? { text } : { attachment: { type: step.type, payload: { url: step.content } } }
            }, { headers: { 'Authorization': `Bearer ${settings.metaToken}` } });
        }
    }
}

// 5. API de Leads
app.get('/api/leads', (req, res) => res.json(leads));
app.post('/api/leads', (req, res) => {
    const newLead = { ...req.body, id: Date.now() };
    leads.unshift(newLead);
    res.json(newLead);
});

app.listen(PORT, () => {
    console.log(`\n🚀 SERVIDOR KORVIA BACKEND ATIVO`);
    console.log(`📡 Endereço local: http://localhost:${PORT}`);
});