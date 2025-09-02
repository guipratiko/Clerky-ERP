// Clerky CRM - Sistema de CRM com WhatsApp
// Desenvolvido com Node.js, React, Socket.io e MongoDB

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const mongoose = require('mongoose');
const { MessageMedia } = require('whatsapp-web.js');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const platformConfig = require('./platform-config');
require('dotenv').config();

// Inicializar app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middlewares
app.use(express.json({ 
  limit: '50mb' // Aumentar limite para suportar áudios grandes em base64
}));
app.use(express.urlencoded({ 
  extended: true,
  limit: '50mb' // Aumentar limite para suportar áudios grandes
}));
app.use(express.static('public'));

// Configuração de sessão
app.use(session({
  secret: 'clerky-crm-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Configuração do multer para upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadsDir = 'public/uploads/';
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
    cb(null, name);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Configuração do MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/clerky-crm';

mongoose.connect(MONGODB_URI).then(async () => {
  console.log('✅ Conectado ao MongoDB!');
  
  // Exibir informações da plataforma
  platformConfig.logPlatformInfo();
  
  // Carregar configurações de integração
  await loadIntegrationsFromDB();
}).catch((error) => {
  console.error('❌ Erro ao conectar ao MongoDB:', error);
});

// Schemas - Apenas mensagens e usuários no banco
const messageSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true },
  messageId: String,
  body: String,
  type: { type: String, enum: ['text', 'image', 'audio', 'document', 'video', 'chat', 'ptt', 'location', 'vcard', 'multi_vcard', 'revoked', 'order', 'unknown', 'notification_template'], default: 'text' },
  mediaUrl: String,
  isFromMe: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['sent', 'delivered', 'read'], default: 'sent' },
  chatId: String, // ID do chat completo
  // Campos para controle do n8n e evitar loops
  fromN8n: { type: Boolean, default: false },
  n8nSource: String // 'sistema', 'usuario', etc.
});

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'agent'], default: 'agent' },
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);
const User = mongoose.model('User', userSchema);

// Schema para CRM - Informações detalhadas do cliente
const clientSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  email: String,
  company: String,
  position: String,
  address: String,
  city: String,
  state: String,
  zipCode: String,
  birthDate: Date,
  notes: [{ 
    text: String, 
    createdBy: String, 
    createdAt: { type: Date, default: Date.now } 
  }],
  tags: [String],
  status: { 
    type: String, 
    enum: ['novo', 'andamento', 'aprovado', 'reprovado'], 
    default: 'novo' 
  },
  priority: { 
    type: String, 
    enum: ['low', 'medium', 'high', 'urgent'], 
    default: 'medium' 
  },
  source: { 
    type: String, 
    enum: ['whatsapp', 'website', 'referral', 'social', 'advertising', 'appmax', 'other'], 
    default: 'whatsapp' 
  },
  assignedTo: String,
  lastContact: { type: Date, default: Date.now },
  nextFollowUp: Date,
  dealValue: Number,
  dealStage: { 
    type: String, 
    enum: ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed-won', 'closed-lost', 'lost'], 
    default: 'prospecting' 
  },
  customFields: [{
    key: String,
    value: String
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const ClientModel = mongoose.model('Client', clientSchema);

// Schema para Templates Salvos
const templateSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  descricao: String,
  tipoTemplate: { 
    type: String, 
    enum: ['texto', 'imagem', 'imagem-legenda', 'audio', 'arquivo', 'arquivo-legenda'], 
    required: true 
  },
  mensagem: String,
  legenda: String,
  arquivo: String, // Caminho do arquivo
  nomeArquivoOriginal: String, // Nome original do arquivo
  tamanhoArquivo: Number, // Tamanho em bytes
  mimetypeArquivo: String, // Tipo MIME do arquivo
  criadoPor: { type: String, required: true },
  criadoEm: { type: Date, default: Date.now },
  atualizadoEm: { type: Date, default: Date.now },
  usadoEm: { type: Date, default: Date.now }, // Última vez que foi usado
  vezesUsado: { type: Number, default: 0 } // Contador de uso
});

const Template = mongoose.model('Template', templateSchema);

// Schema para Configurações de Integração
const integrationSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  n8nTestUrl: { type: String, default: '' },
  n8nProdUrl: { type: String, default: '' },
  n8nSentUrl: { type: String, default: '' },
  webhookReceiveUrl: { type: String, default: '' },
  iaEnabled: { type: Boolean, default: false },
  massDispatchBypass: { type: Boolean, default: true },
  useTestUrl: { type: Boolean, default: false }, // Alternar entre teste e produção
  // Configurações AppMax
  appmaxEnabled: { type: Boolean, default: false },
  appmaxApiKey: { type: String, default: '' },
  appmaxApiUrl: { type: String, default: '' },
  appmaxWebhookSecret: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String
});

const Integration = mongoose.model('Integration', integrationSchema);

// Sem cache necessário - trabalhamos em tempo real

// Variables globais
const APP_START_TIME = Date.now(); // Tempo de início da aplicação

// Cache para estatísticas do dashboard
let dashboardStatsCache = {
  data: null,
  lastUpdate: 0,
  cacheTime: 10 * 1000 // 10 segundos em milissegundos (tempo real)
};
let whatsappClient = null;
let isReady = false;
let qrCodeData = null;
// Variáveis de controle de mensagens removidas - sistema agora funciona apenas com webhooks centralizados


// Configurações de integração (cache em memória)
let integrationsConfig = {
  n8nTestUrl: '',
  n8nProdUrl: '',
  n8nSentUrl: '', // Webhook para mensagens enviadas (fromMe = true)
  webhookReceiveUrl: '',
  iaEnabled: false,
  massDispatchBypass: true,
  useTestUrl: false, // Chave para alternar entre teste e produção
  // Configurações AppMax
  appmaxEnabled: false,
  appmaxApiKey: '',
  appmaxApiUrl: '',
  appmaxWebhookSecret: ''
};

// Controle de disparo em massa ativo
let massDispatchActive = {
  isActive: false,
  startTime: null,
  endTime: null,
  sentNumbers: new Set() // Números para os quais foram enviadas mensagens no disparo atual
};

// Controle de mensagens enviadas pela página de chat
const chatPageMessageIds = new Set();
let isPageChatSending = false;
let isN8nResponseSending = false;

// Limpeza periódica do Set para evitar acúmulo de memória
setInterval(() => {
  chatPageMessageIds.clear();
}, 60000); // Limpar a cada 60 segundos

// Controle de estado do disparo (para parar/pausar)
let disparoControlState = {
  shouldStop: false,
  currentDispatchId: null,
  progress: {
    total: 0,
    validated: 0,
    sent: 0,
    failed: 0,
    invalidNumbers: [],
    validationPhase: false,
    sendingPhase: false
  }
};

// Número próprio do WhatsApp (será obtido quando conectar)
let myWhatsAppNumber = null;

// Função para validar se um número tem WhatsApp ativo
async function validarNumeroWhatsApp(numeroCompleto) {
  try {
    const whatsappNumber = numeroCompleto + '@c.us';
    console.log(`🔍 Validando se ${numeroCompleto} tem WhatsApp...`);
    
    const numberId = await whatsappClient.getNumberId(whatsappNumber);
    
    if (numberId) {
      console.log(`✅ ${numeroCompleto} tem WhatsApp ativo`);
      return { valid: true, numberId: numberId };
    } else {
      console.log(`❌ ${numeroCompleto} NÃO tem WhatsApp`);
      return { valid: false, numberId: null };
    }
  } catch (error) {
    console.error(`❌ Erro ao validar ${numeroCompleto}:`, error.message);
    return { valid: false, numberId: null, error: error.message };
  }
}



// Função para determinar se a mensagem é nossa
function isMessageFromMe(message) {
  // Primeiro, verificar o campo fromMe nativo do WhatsApp
  if (message.fromMe === true) {
    console.log('🔍 Mensagem detectada como própria via fromMe nativo');
    return true;
  }
  
  // Se temos o número próprio, verificar se o remetente é nosso número
  if (myWhatsAppNumber && message.from) {
    const fromNumber = message.from.replace('@c.us', '').replace('@g.us', '');
    if (fromNumber === myWhatsAppNumber) {
      console.log(`🔍 Mensagem detectada como própria via from: ${fromNumber} === ${myWhatsAppNumber}`);
      return true;
    }
  }
  
  // Verificar se o autor da mensagem é nosso número (para grupos)
  if (myWhatsAppNumber && message.author) {
    const authorNumber = message.author.replace('@c.us', '').replace('@g.us', '');
    if (authorNumber === myWhatsAppNumber) {
      console.log(`🔍 Mensagem detectada como própria via author: ${authorNumber} === ${myWhatsAppNumber}`);
      return true;
    }
  }
  
  // Log para debug quando não conseguimos detectar
  if (myWhatsAppNumber) {
    console.log(`🔍 Análise de mensagem: fromMe=${message.fromMe}, from=${message.from}, author=${message.author}, myNumber=${myWhatsAppNumber}`);
  }
  
  return false;
}

// Função para carregar configurações do banco
async function loadIntegrationsFromDB() {
  try {
    const config = await Integration.findOne({ key: 'main' });
    if (config) {
      integrationsConfig = {
        n8nTestUrl: config.n8nTestUrl || '',
        n8nProdUrl: config.n8nProdUrl || '',
        n8nSentUrl: config.n8nSentUrl || '',
        webhookReceiveUrl: config.webhookReceiveUrl || '',
        iaEnabled: config.iaEnabled || false,
        massDispatchBypass: config.massDispatchBypass !== false, // default true
        useTestUrl: config.useTestUrl || false, // default false (produção)
        // Configurações AppMax
        appmaxEnabled: config.appmaxEnabled || false,
        appmaxApiKey: config.appmaxApiKey || '',
        appmaxApiUrl: config.appmaxApiUrl || '',
        appmaxWebhookSecret: config.appmaxWebhookSecret || ''
      };
      console.log('🔗 Configurações de integração carregadas do banco:', integrationsConfig);
    } else {
      console.log('🔗 Nenhuma configuração de integração encontrada, usando padrões');
    }
  } catch (error) {
    console.error('❌ Erro ao carregar configurações de integração:', error);
  }
}

// Função para salvar configurações no banco
async function saveIntegrationsToDB(config, updatedBy = 'system') {
  try {
    await Integration.findOneAndUpdate(
      { key: 'main' },
      {
        ...config,
        updatedAt: new Date(),
        updatedBy
      },
      { upsert: true, new: true }
    );
    console.log('💾 Configurações de integração salvas no banco');
  } catch (error) {
    console.error('❌ Erro ao salvar configurações de integração:', error);
    throw error;
  }
}



// Inicializar WhatsApp
function initializeWhatsAppClient() {
  const whatsappConfig = platformConfig.getWhatsAppConfig();
  
  whatsappClient = new Client({
    authStrategy: new LocalAuth({ clientId: whatsappConfig.clientId }),
    puppeteer: whatsappConfig.puppeteer,
    authTimeoutMs: whatsappConfig.authTimeoutMs,
    restartOnAuthFail: whatsappConfig.restartOnAuthFail,
    qrMaxRetries: whatsappConfig.qrMaxRetries,
    takeoverOnConflict: whatsappConfig.takeoverOnConflict,
    takeoverTimeoutMs: whatsappConfig.takeoverTimeoutMs
  });

  console.log('🔧 Configuração do WhatsApp aplicada para:', platformConfig.isWindows ? 'Windows' : platformConfig.isMac ? 'macOS' : 'Linux');
  
  setupClientEvents();
  whatsappClient.initialize();
}

function setupClientEvents() {
  whatsappClient.on('qr', async (qr) => {
    try {
      qrCodeData = await qrcode.toDataURL(qr);
      io.emit('qr-update', { qrCode: qrCodeData });
      console.log('🔄 QR Code gerado');
    } catch (error) {
      console.error('❌ Erro ao gerar QR Code:', error);
    }
  });

  whatsappClient.on('authenticated', () => {
    console.log('✅ Cliente autenticado!');
    io.emit('client-authenticated');
  });

  whatsappClient.on('ready', async () => {
    isReady = true;
    console.log('🚀 WhatsApp Client pronto!');
    console.log('📱 Sistema funcionando em tempo real com WhatsApp');
    
    // Obter número próprio do WhatsApp
    try {
      const info = await whatsappClient.getState();
      const me = await whatsappClient.info;
      if (me && me.wid && me.wid.user) {
        myWhatsAppNumber = me.wid.user;
        console.log(`📱 Número próprio detectado: ${myWhatsAppNumber}`);
      }
    } catch (error) {
      console.log('⚠️ Não foi possível obter número próprio:', error.message);
    }
    
    // Registrar todos os listeners ativos
    const activeEvents = whatsappClient.eventNames();
    console.log('🔧 Eventos registrados:', activeEvents);
    
    io.emit('client-ready');
  });

  // Evento "message" para capturar mensagens recebidas
  whatsappClient.on('message', async (message) => {
    try {
      // Apenas processar mensagens recebidas (não enviadas por nós)
      if (message.fromMe) {
        return;
      }
      
      // Ignorar mensagens do status@broadcast
      if (message.from === 'status@broadcast') {
        return;
      }
      
      // Salvar mensagem no banco
      const messageData = {
        phoneNumber: message.from.replace('@c.us', ''),
        messageId: message.id._serialized,
        body: message.body || '',
        type: message.type || 'text',
        mediaUrl: null,
        isFromMe: false,
        timestamp: new Date(message.timestamp * 1000),
        chatId: message.from
      };
    
      if (message.hasMedia) {
        const media = await message.downloadMedia();
        if (media) {
          const filename = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}.${media.mimetype.split('/')[1]}`;
          const filePath = path.join('public/uploads/', filename);
          await fs.writeFile(filePath, media.data, 'base64');
          messageData.mediaUrl = `/uploads/${filename}`;
        }
      }
      
      // Salvar no banco
      const msg = new Message(messageData);
      await msg.save();
      
      // Obter nome do contato
      const contactInfo = await message.getContact();
      const contactName = contactInfo.name || contactInfo.pushname || messageData.phoneNumber;
      
      // Estruturar dados no formato esperado pelo frontend
      const eventData = {
        contactId: messageData.phoneNumber,
        contact: {
          _id: messageData.phoneNumber,
          phoneNumber: messageData.phoneNumber,
          name: contactName,
          profilePic: null
        },
        message: {
          _id: msg._id,
          phoneNumber: messageData.phoneNumber,
          messageId: messageData.messageId,
          body: messageData.body,
          type: messageData.type,
          mediaUrl: messageData.mediaUrl,
          isFromMe: false,
          timestamp: messageData.timestamp,
          chatId: messageData.chatId
        }
      };
      
      // Emitir para interface do chat
      io.emit('new-message', eventData);
      
      // Preparar dados de áudio se for mensagem de áudio
      let audioData = null;
      if ((messageData.type === 'audio' || messageData.type === 'ptt') && message.hasMedia) {
        try {
          const media = await message.downloadMedia();
          if (media && media.data) {
            audioData = media.data;
          }
        } catch (audioError) {
          console.log('⚠️ Erro ao baixar áudio para webhook:', audioError.message);
        }
      }

      // Enviar webhook para n8n com payload completo
      await sendCentralizedWebhook('message_received', {
        phoneNumber: messageData.phoneNumber,
        name: contactName,
        body: messageData.body,
        type: messageData.type,
        timestamp: messageData.timestamp,
        chatId: messageData.chatId,
        to: myWhatsAppNumber + '@c.us',
        audioData: audioData
      });
      
    } catch (error) {
      console.error('❌ Erro ao processar mensagem recebida:', error);
    }
  });

  // Evento "message_create" para capturar apenas mensagens enviadas pelo celular
  whatsappClient.on('message_create', async (message) => {
    try {
      // Apenas processar mensagens enviadas por nós através do celular
      if (!message.fromMe) {
        return;
      }
      
      // Ignorar mensagens do status@broadcast
      if (message.from === 'status@broadcast' || message.to === 'status@broadcast') {
        return;
      }
      
      // Ignorar mensagens enviadas pela página de chat (usando flag e Set)
      if (isPageChatSending || (message.id && message.id._serialized && chatPageMessageIds.has(message.id._serialized))) {
        console.log('🚫 Mensagem da página de chat ignorada no message_create');
        // Remover do Set após uso para evitar acúmulo de memória
        if (message.id && message.id._serialized) {
          chatPageMessageIds.delete(message.id._serialized);
    }
        return;
      }
      
      // Ignorar mensagens enviadas como resposta do n8n
      if (isN8nResponseSending) {
        console.log('🚫 Mensagem de resposta do n8n ignorada no message_create');
        return;
      }
      
      // Verificar se a mensagem foi enviada pelo celular (não pela web)
      if (message.deviceType === 'web') {
        return;
      }
      
      // Enviar webhook para n8n com payload simples
      console.log('📱 Enviando webhook message_sent_mobile para mensagem do celular');
      await sendCentralizedWebhook('message_sent_mobile', {
        author: myWhatsAppNumber,
        to: message.to
      });
      
    } catch (error) {
      console.error('❌ Erro ao processar mensagem enviada pelo celular:', error);
    }
  });











  whatsappClient.on('auth_failure', () => {
    console.log('❌ Falha na autenticação');
    io.emit('auth-failure');
  });

  whatsappClient.on('disconnected', () => {
    isReady = false;
    qrCodeData = null;
    console.log('🔌 Cliente desconectado');
    io.emit('client-disconnected');
  });

  // Interceptador para debug de eventos
  const originalEmit = whatsappClient.emit;
  whatsappClient.emit = function(event, ...args) {
    // Não capturar nenhum evento para debug
    return originalEmit.apply(this, [event, ...args]);
  };
}

// Buscar contatos em tempo real do WhatsApp
// OTIMIZAÇÃO ULTRA-RÁPIDA: Removidas consultas ao banco e processamento desnecessário
async function getWhatsAppContacts() {
  try {
    if (!isReady || !whatsappClient) {
      return [];
    }

    const startTime = Date.now();
    const chats = await whatsappClient.getChats();
    
    // OTIMIZAÇÃO 1: Processar apenas os primeiros 50 chats mais recentes
    const recentChats = chats
      .filter(chat => !chat.isGroup && chat.lastMessage) // Filtrar grupos e chats sem mensagens
      .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0))
      .slice(0, 50); // Limite de 50 contatos para carregamento instantâneo
    
    console.log(`📊 Processando ${recentChats.length} contatos mais recentes de ${chats.length} chats totais`);
    
    // OTIMIZAÇÃO 2: Usar Promise.all para processamento paralelo
    const contacts = await Promise.all(
      recentChats.map(async (chat) => {
        try {
          // OTIMIZAÇÃO 3: Usar dados direto do chat sem consultas extras
          const contact = await chat.getContact();
          
          return {
            _id: contact.id.user,
            phoneNumber: contact.id.user,
            name: contact.name || contact.pushname || contact.id.user,
            profilePic: null, // Removido para performance máxima
            isGroup: false, // Já filtrados acima
            lastMessage: chat.lastMessage?.body || '',
            lastMessageTime: chat.lastMessage?.timestamp ? new Date(chat.lastMessage.timestamp * 1000) : new Date(),
            unreadCount: chat.unreadCount || 0,
            chatId: chat.id._serialized
          };
        } catch (contactError) {
          console.log(`⚠️ Erro ao processar contato: ${contactError.message}`);
          return null;
        }
      })
    );
    
    // OTIMIZAÇÃO 4: Filtrar resultados nulos e já vem ordenado
    const validContacts = contacts.filter(contact => contact !== null);
    
    console.log(`⚡ ULTRA-RÁPIDO: ${validContacts.length} contatos carregados em ${Date.now() - startTime}ms (sem consultas ao banco)`);
    
    return validContacts;
  } catch (error) {
    console.error('❌ Erro ao buscar contatos do WhatsApp:', error);
    return [];
  }
}


// Função handleIncomingMessage removida - sistema agora funciona apenas com webhooks centralizados

// Middleware de autenticação
function requireAuth(req, res, next) {
  if (req.session.userId) {
    next();
  } else {
    res.redirect('/login');
  }
}

// ROTAS

// Login
app.get('/login', (req, res) => {
  res.send(getLoginHTML());
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    let user = await User.findOne({ username });
    
    if (!user && username === 'Guilherme') {
      const hashedPassword = await bcrypt.hash('Home1366!', 10);
      user = new User({
        username: 'Guilherme',
        password: hashedPassword,
        role: 'admin'
      });
      await user.save();
    }
    
    if (user && await bcrypt.compare(password, user.password)) {
      req.session.userId = user._id;
      req.session.userRole = user.role;
      req.session.user = {
        username: user.username,
        role: user.role
      };
      res.redirect('/');
    } else {
      res.redirect('/login?error=1');
    }
  } catch (error) {
    console.error('❌ Erro no login:', error);
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Página principal - Dashboard pós-login
app.get('/', requireAuth, (req, res) => {
  res.send(getDashboardHTML());
});

// Página de chat
app.get('/chat', requireAuth, (req, res) => {
  res.send(getMainHTML());
});

// Página de gerenciamento do WhatsApp
app.get('/whatsapp', requireAuth, (req, res) => {
  res.send(getWhatsAppManagementHTML());
});

app.get('/disparo', requireAuth, (req, res) => {
  res.send(getDisparoHTML());
});

// ========== ROTAS DA API DE TEMPLATES ==========

// Listar todos os templates
app.get('/api/templates', requireAuth, async (req, res) => {
  try {
    const templates = await Template.find()
      .sort({ usadoEm: -1, criadoEm: -1 })
      .lean();
    
    res.json({ success: true, templates });
  } catch (error) {
    console.error('❌ Erro ao listar templates:', error);
    res.status(500).json({ success: false, message: 'Erro ao listar templates' });
  }
});

// Salvar novo template
app.post('/api/templates', requireAuth, async (req, res) => {
  try {
    const { nome, descricao, tipoTemplate, mensagem, legenda, arquivo, nomeArquivoOriginal, tamanhoArquivo, mimetypeArquivo } = req.body;
    const criadoPor = req.session?.user?.username || 'Sistema';
    
    // Validações básicas
    if (!nome || !tipoTemplate) {
      return res.status(400).json({ success: false, message: 'Nome e tipo do template são obrigatórios' });
    }
    
    // Verificar se já existe template com o mesmo nome
    const templateExistente = await Template.findOne({ nome });
    if (templateExistente) {
      return res.status(400).json({ success: false, message: 'Já existe um template com este nome' });
    }
    
    // Criar novo template
    const novoTemplate = new Template({
      nome,
      descricao,
      tipoTemplate,
      mensagem,
      legenda,
      arquivo,
      nomeArquivoOriginal,
      tamanhoArquivo,
      mimetypeArquivo,
      criadoPor
    });
    
    await novoTemplate.save();
    
    console.log(`✅ Template "${nome}" salvo por ${criadoPor}`);
    res.json({ success: true, template: novoTemplate });
    
  } catch (error) {
    console.error('❌ Erro ao salvar template:', error);
    res.status(500).json({ success: false, message: 'Erro ao salvar template' });
  }
});

// Carregar template específico
app.get('/api/templates/:id', requireAuth, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template não encontrado' });
    }
    
    // Atualizar estatísticas de uso
    template.usadoEm = new Date();
    template.vezesUsado += 1;
    await template.save();
    
    console.log(`📋 Template "${template.nome}" carregado (${template.vezesUsado}x usado)`);
    res.json({ success: true, template });
    
  } catch (error) {
    console.error('❌ Erro ao carregar template:', error);
    res.status(500).json({ success: false, message: 'Erro ao carregar template' });
  }
});

// Atualizar template
app.put('/api/templates/:id', requireAuth, async (req, res) => {
  try {
    const { nome, descricao, tipoTemplate, mensagem, legenda } = req.body;
    
    const template = await Template.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template não encontrado' });
    }
    
    // Verificar se o novo nome já existe (se foi alterado)
    if (nome !== template.nome) {
      const templateExistente = await Template.findOne({ nome });
      if (templateExistente) {
        return res.status(400).json({ success: false, message: 'Já existe um template com este nome' });
      }
    }
    
    // Atualizar campos
    template.nome = nome;
    template.descricao = descricao;
    template.tipoTemplate = tipoTemplate;
    template.mensagem = mensagem;
    template.legenda = legenda;
    template.atualizadoEm = new Date();
    
    await template.save();
    
    console.log(`✏️ Template "${nome}" atualizado`);
    res.json({ success: true, template });
    
  } catch (error) {
    console.error('❌ Erro ao atualizar template:', error);
    res.status(500).json({ success: false, message: 'Erro ao atualizar template' });
  }
});

// Excluir template
app.delete('/api/templates/:id', requireAuth, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template não encontrado' });
    }
    
    // Excluir arquivo associado se existir
    if (template.arquivo) {
      const caminhoArquivo = path.join(__dirname, 'public', template.arquivo);
      try {
        if (fs.existsSync(caminhoArquivo)) {
          fs.unlinkSync(caminhoArquivo);
          console.log(`🗑️ Arquivo removido: ${template.arquivo}`);
        }
      } catch (error) {
        console.warn(`⚠️ Não foi possível remover arquivo: ${template.arquivo}`, error.message);
      }
    }
    
    // Remover template do banco
    await Template.findByIdAndDelete(req.params.id);
    
    console.log(`🗑️ Template "${template.nome}" excluído`);
    res.json({ success: true, message: 'Template excluído com sucesso' });
    
  } catch (error) {
    console.error('❌ Erro ao excluir template:', error);
    res.status(500).json({ success: false, message: 'Erro ao excluir template' });
  }
});

// API para upload de arquivos
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado' });
    }

    const fileInfo = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      url: `/uploads/${req.file.filename}`,
      type: getFileType(req.file.mimetype)
    };

    console.log('📎 Arquivo enviado:', fileInfo.originalName, '(' + formatFileSize(fileInfo.size) + ')');
    res.json({ success: true, file: fileInfo });
  } catch (error) {
    console.error('❌ Erro no upload:', error);
    res.status(500).json({ success: false, message: 'Erro no upload do arquivo' });
  }
});

// Função para determinar tipo do arquivo
function getFileType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.includes('pdf')) return 'pdf';
  if (mimetype.includes('word') || mimetype.includes('document')) return 'document';
  if (mimetype.includes('sheet') || mimetype.includes('excel')) return 'spreadsheet';
  if (mimetype.includes('presentation') || mimetype.includes('powerpoint')) return 'presentation';
  return 'file';
}

// Função para formatar tamanho do arquivo
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isProblematicForWhatsApp(filePath, fileSize) {
  const ext = path.extname(filePath).toLowerCase();
  const fileSizeMB = fileSize / (1024 * 1024);
  
  // Formatos conhecidos por sempre dar problema
  const alwaysProblematicFormats = ['.wmv', '.flv', '.avi', '.mkv'];
  if (alwaysProblematicFormats.includes(ext)) {
    return true;
  }
  
  // Arquivos muito grandes em geral (acima do limite do WhatsApp)
  if (fileSizeMB > 60) {
    return true;
  }
  
  // Para MP4, só considerar problemático se for muito grande
  if (ext === '.mp4' && fileSizeMB > 30) {
    return true;
  }
  
  return false;
}

function getMimeTypeFromExtension(extension) {
  const mimeTypes = {
    // Áudio (ordem de compatibilidade)
    '.wav': 'audio/wav',        // Prioridade máxima
    '.mp3': 'audio/mpeg',       // Segunda prioridade
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.webm': 'audio/webm',      // Menos compatível
    '.opus': 'audio/opus',
    
    // Imagens
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    
    // Documentos
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.rtf': 'application/rtf',
    '.csv': 'text/csv',
    
    // Vídeo
    '.mp4': 'video/mp4',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.wmv': 'video/x-ms-wmv',
    
    // Outros
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed'
  };
  
  return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
}

// Função para converter áudio usando fluent-ffmpeg
async function converterAudioParaMP3(inputPath, outputPath) {
  const ffmpeg = require('fluent-ffmpeg');
  const { promisify } = require('util');
  
  return new Promise((resolve, reject) => {
    console.log('🔄 Iniciando conversão do áudio:', inputPath);
    console.log('📁 Arquivo de saída:', outputPath);

    // Verifica se o arquivo de entrada existe
    if (!require('fs').existsSync(inputPath)) {
      return reject(new Error('Arquivo de entrada não encontrado'));
    }

    // Verifica se o arquivo de saída já existe
    if (require('fs').existsSync(outputPath)) {
      console.log('✅ Arquivo MP3 já existe, usando ele');
      return resolve(outputPath);
    }

    ffmpeg(inputPath)
      .toFormat('mp3')
      .audioBitrate('128k')
      .outputOptions('-y')
      .audioChannels(1)
      .audioFrequency(44100)
      .on('start', (commandLine) => {
        console.log('🎵 Comando ffmpeg:', commandLine);
      })
      .on('progress', (progress) => {
        console.log('📊 Progresso da conversão:', Math.round(progress.percent || 0) + '%');
      })
      .on('end', () => {
        console.log('✅ Conversão para MP3 concluída:', outputPath);
        // Verifica se o arquivo foi criado
        if (require('fs').existsSync(outputPath)) {
          resolve(outputPath);
        } else {
          reject(new Error('Arquivo MP3 não foi criado'));
        }
      })
      .on('error', (err) => {
        console.error('❌ Erro na conversão para MP3:', err);
        reject(err);
      })
      .save(outputPath);
  });
}

// Função para otimizar áudio para WhatsApp (atualizada para MP3)
function optimizeAudioForWhatsApp(filePath, fileData) {
  const fs = require('fs');
  const path = require('path');
  
  try {
    const stats = fs.statSync(filePath);
    const fileSizeKB = stats.size / 1024;
    const fileName = path.basename(filePath);
    const fileExt = path.extname(filePath).toLowerCase();
    
    console.log(`🔍 Analisando áudio: ${fileName} (${fileSizeKB.toFixed(1)} KB)`);
    
    // Configurações otimizadas priorizando MP3 para PTT
    const audioOptimizations = {
      '.mp3': {
        preferredMime: 'audio/mpeg',
        fallbackMimes: ['audio/wav', 'audio/ogg; codecs=opus'],
        maxSizeKB: 16000,
        pttCompatible: true,
        priority: 1,
        needsConversion: false
      },
      '.wav': {
        preferredMime: 'audio/mpeg', // Converte WAV para MP3
        fallbackMimes: ['audio/wav', 'audio/ogg; codecs=opus'],
        maxSizeKB: 16000,
        pttCompatible: true,
        priority: 2,
        needsConversion: true,
        convertTo: '.mp3'
      },
      '.webm': {
        preferredMime: 'audio/mpeg', // Converte WebM para MP3
        fallbackMimes: ['audio/wav', 'audio/ogg; codecs=opus'],
        maxSizeKB: 16000,
        pttCompatible: true,
        priority: 3,
        needsConversion: true,
        convertTo: '.mp3'
      },
      '.m4a': {
        preferredMime: 'audio/mpeg', // Converte M4A para MP3
        fallbackMimes: ['audio/wav', 'audio/ogg; codecs=opus'],
        maxSizeKB: 16000,
        pttCompatible: true,
        priority: 4,
        needsConversion: true,
        convertTo: '.mp3'
      },
      '.ogg': {
        preferredMime: 'audio/ogg; codecs=opus',
        fallbackMimes: ['audio/mpeg', 'audio/wav'],
        maxSizeKB: 16000,
        pttCompatible: true,
        priority: 5,
        needsConversion: false
      }
    };
    
    const config = audioOptimizations[fileExt] || {
      preferredMime: 'audio/mpeg',
      fallbackMimes: ['audio/wav', 'audio/ogg; codecs=opus'],
      maxSizeKB: 16000,
      pttCompatible: true,
      priority: 6,
      needsConversion: true,
      convertTo: '.mp3'
    };
    
    // Verificar tamanho
    if (fileSizeKB > config.maxSizeKB) {
      console.log(`⚠️ Arquivo muito grande (${fileSizeKB.toFixed(1)} KB > ${config.maxSizeKB} KB)`);
      return {
        success: false,
        reason: 'file_too_large',
        config: null
      };
    }
    
    // PTT é sempre recomendado para arquivos menores que 10MB
    const isPttRecommended = config.pttCompatible && fileSizeKB < 10000;
    
    // Retornar configuração otimizada
    return {
      success: true,
      config: {
        ...config,
        fileName,
        fileExt,
        fileSizeKB: fileSizeKB.toFixed(1),
        isPttRecommended,
        strategies: ['ptt-mp3', 'ptt-original', 'audio', 'document'] // Sempre tenta PTT primeiro
      }
    };
    
  } catch (error) {
    console.error('❌ Erro ao otimizar áudio:', error.message);
    return {
      success: false,
      reason: 'optimization_failed',
      config: null
    };
  }
}

// APIs
app.get('/api/status', (req, res) => {
  res.json({
    isConnected: isReady,
    qrCode: qrCodeData
  });
});

// API para informações detalhadas do WhatsApp
app.get('/api/whatsapp/info', requireAuth, (req, res) => {
  try {
    const info = {
      isConnected: isReady,
      qrCode: qrCodeData,
      clientState: whatsappClient ? whatsappClient.info : null,
      uptime: process.uptime(),
      version: require('./package.json').version || '1.0.0',
      nodeVersion: process.version,
      platform: process.platform,
      timestamp: new Date().toISOString()
    };
    res.json({ success: true, info });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Erro ao obter informações', error: error.message });
  }
});

// API para estatísticas do dashboard
// API para obter logs do sistema
app.get('/api/system-logs', requireAuth, (req, res) => {
  res.json({ success: true, logs: systemLogs });
});

app.get('/api/dashboard-stats', requireAuth, async (req, res) => {
  try {
    const agora = Date.now();
    
    // Verificar se o cache ainda é válido
    if (dashboardStatsCache.data && (agora - dashboardStatsCache.lastUpdate) < dashboardStatsCache.cacheTime) {
      return res.json(dashboardStatsCache.data);
    }
    
    // Calcular mensagens enviadas (apenas mensagens enviadas por nós)
    const mensagensEnviadas = await Message.countDocuments({ isFromMe: true });
    
    // Calcular clientes ativos (contatos únicos que trocaram mensagens nos últimos 30 dias)
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - 30);
    
    const clientesAtivos = await Message.distinct('phoneNumber', {
      timestamp: { $gte: dataLimite }
    });
    
    // Calcular taxa de conversão realista baseada no CRM
    const totalClientes = await ClientModel.countDocuments();
    const clientesAprovados = await ClientModel.countDocuments({ status: 'aprovado' });
    const clientesAndamento = await ClientModel.countDocuments({ status: 'andamento' });
    
    let taxaConversao = 0;
    if (totalClientes > 0) {
      // Taxa de conversão = (aprovados / total) * 100
      taxaConversao = Math.round((clientesAprovados / totalClientes) * 100);
    } else if (clientesAtivos.length > 0) {
      // Se não há dados de CRM, usar uma taxa conservadora baseada em atividade
      taxaConversao = Math.min(15, Math.round((clientesAtivos.length / 10) * 100));
    }
    
    // Calcular uptime baseado na conexão do WhatsApp
    let uptime = 0;
    if (isReady) {
      // Se WhatsApp está conectado, uptime alto
      const tempoAtual = Date.now();
      const tempoTotal = (tempoAtual - APP_START_TIME) / 1000 / 3600; // em horas
      
      if (tempoTotal < 1) {
        uptime = 95; // 95% nas primeiras horas
      } else if (tempoTotal < 24) {
        uptime = Math.min(99.5, 95 + (tempoTotal / 24) * 4.5); // Cresce até 99.5% em 24h
      } else {
        uptime = 99.8; // Uptime estável após 24h
      }
    } else {
      // Se WhatsApp não está conectado, uptime baixo
      uptime = 0;
    }
    uptime = Math.round(uptime * 10) / 10; // Arredondar para 1 casa decimal
    
    const stats = {
      mensagensEnviadas,
      clientesAtivos: clientesAtivos.length,
      taxaConversao,
      uptime
    };
    
    // Atualizar cache
    dashboardStatsCache.data = stats;
    dashboardStatsCache.lastUpdate = agora;
    
    res.json(stats);
  } catch (error) {
    console.error('❌ Erro ao calcular estatísticas:', error);
    const fallbackStats = { 
      mensagensEnviadas: 0,
      clientesAtivos: 0,
      taxaConversao: 0,
      uptime: 0
    };
    
    // Em caso de erro, retornar o último cache válido ou dados padrão
    res.status(500).json(dashboardStatsCache.data || fallbackStats);
  }
});

// API para desconectar WhatsApp
app.post('/api/whatsapp/disconnect', requireAuth, async (req, res) => {
  try {
    if (whatsappClient) {
      await whatsappClient.destroy();
      whatsappClient = null;
      isReady = false;
      qrCodeData = null;
      console.log('🔌 WhatsApp desconectado manualmente');
      io.emit('client-disconnected');
    }
    res.json({ success: true, message: 'WhatsApp desconectado' });
  } catch (error) {
    console.error('❌ Erro ao desconectar:', error);
    res.status(500).json({ success: false, message: 'Erro ao desconectar', error: error.message });
  }
});

// API para reconectar WhatsApp
app.post('/api/whatsapp/reconnect', requireAuth, async (req, res) => {
  try {
    if (whatsappClient) {
      await whatsappClient.destroy();
    }
    
    whatsappClient = null;
    isReady = false;
    qrCodeData = null;
    
    console.log('🔄 Reiniciando conexão WhatsApp...');
    setTimeout(() => {
      initializeWhatsAppClient();
    }, 2000);
    
    res.json({ success: true, message: 'Reconectando WhatsApp...' });
  } catch (error) {
    console.error('❌ Erro ao reconectar:', error);
    res.status(500).json({ success: false, message: 'Erro ao reconectar', error: error.message });
  }
});

// API para limpar sessão do WhatsApp
app.post('/api/whatsapp/clear-session', requireAuth, async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    
    if (whatsappClient) {
      await whatsappClient.destroy();
    }
    
    // Limpar diretório de sessão
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log('🗑️ Sessão WhatsApp limpa');
    }
    
    whatsappClient = null;
    isReady = false;
    qrCodeData = null;
    
    setTimeout(() => {
      initializeWhatsAppClient();
    }, 3000);
    
    res.json({ success: true, message: 'Sessão limpa e reconectando...' });
  } catch (error) {
    console.error('❌ Erro ao limpar sessão:', error);
    res.status(500).json({ success: false, message: 'Erro ao limpar sessão', error: error.message });
  }
});

app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    if (!isReady) {
      return res.json({ success: false, message: 'WhatsApp não conectado', contacts: [] });
    }

    const contacts = await getWhatsAppContacts();
    res.json({ success: true, contacts });
  } catch (error) {
    console.error('❌ Erro ao listar contatos:', error);
    res.status(500).json({ success: false, message: 'Erro ao listar contatos', contacts: [] });
  }
});

// API ultra-otimizada para carregar contatos instantaneamente
app.get('/api/contacts-with-crm', requireAuth, async (req, res) => {
  try {
    if (!isReady) {
      return res.json({ success: false, message: 'WhatsApp não conectado', contacts: [] });
    }

    console.log('🚀 CARREGAMENTO ULTRA-RÁPIDO de contatos...');
    const startTime = Date.now();
    
    // OTIMIZAÇÃO: Buscar contatos do WhatsApp (agora limitado a 50 mais recentes)
    const contacts = await getWhatsAppContacts();
    console.log(`📱 ${contacts.length} contatos obtidos em ${Date.now() - startTime}ms`);
    
    if (contacts.length === 0) {
      return res.json({ 
        success: true, 
        contacts: [],
        stats: { totalContacts: 0, withCRM: 0, loadTime: Date.now() - startTime }
      });
    }
    
    // OTIMIZAÇÃO: Buscar dados de CRM apenas dos contatos carregados
    const phoneNumbers = contacts.map(c => c.phoneNumber);
    const crmData = await ClientModel.find({ 
      phoneNumber: { $in: phoneNumbers } 
    }).lean().limit(50); // Limitar consulta também
    
    console.log(`💾 ${crmData.length} registros de CRM encontrados em ${Date.now() - startTime}ms`);
    
    // OTIMIZAÇÃO: Usar Map para acesso O(1)
    const crmMap = new Map();
    crmData.forEach(client => {
      crmMap.set(client.phoneNumber, client);
    });
    
    // OTIMIZAÇÃO: Combinar dados sem loops desnecessários
    const contactsWithCRM = contacts.map(contact => ({
      ...contact,
      crmData: crmMap.get(contact.phoneNumber) || null
    }));
    
    const finalTime = Date.now() - startTime;
    console.log(`⚡ ULTRA-RÁPIDO: ${contactsWithCRM.length} contatos processados em ${finalTime}ms`);
    
    res.json({ 
      success: true, 
      contacts: contactsWithCRM,
      stats: {
        totalContacts: contacts.length,
        withCRM: crmData.length,
        loadTime: finalTime,
        isLimited: contacts.length >= 50 // Indica se foi limitado
      }
    });
  } catch (error) {
    console.error('❌ Erro ao buscar contatos com CRM:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar contatos com CRM', contacts: [] });
  }
});

// API para carregar TODOS os contatos (uso sob demanda)
app.get('/api/all-contacts', requireAuth, async (req, res) => {
  try {
    if (!isReady) {
      return res.json({ success: false, message: 'WhatsApp não conectado', contacts: [] });
    }

    console.log('🐌 Carregando TODOS os contatos (pode ser lento)...');
    const startTime = Date.now();
    
    const chats = await whatsappClient.getChats();
    
    // Filtrar apenas contatos individuais com mensagens
    const individualChats = chats.filter(chat => !chat.isGroup && chat.lastMessage);
    
    console.log(`📊 Processando ${individualChats.length} contatos completos...`);
    
    // Processar em lotes para não sobrecarregar
    const BATCH_SIZE = 20;
    const allContacts = [];
    
    for (let i = 0; i < individualChats.length; i += BATCH_SIZE) {
      const batch = individualChats.slice(i, i + BATCH_SIZE);
      
      const batchContacts = await Promise.all(
        batch.map(async (chat) => {
          try {
            const contact = await chat.getContact();
            return {
              _id: contact.id.user,
              phoneNumber: contact.id.user,
              name: contact.name || contact.pushname || contact.id.user,
              profilePic: null,
              isGroup: false,
              lastMessage: chat.lastMessage?.body || '',
              lastMessageTime: chat.lastMessage?.timestamp ? new Date(chat.lastMessage.timestamp * 1000) : new Date(),
              unreadCount: chat.unreadCount || 0,
              chatId: chat.id._serialized
            };
          } catch (error) {
            return null;
          }
        })
      );
      
      allContacts.push(...batchContacts.filter(contact => contact !== null));
      
      // Pequena pausa entre lotes
      if (i + BATCH_SIZE < individualChats.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    // Ordenar por última mensagem
    allContacts.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
    
    const finalTime = Date.now() - startTime;
    console.log(`🐌 TODOS os contatos carregados: ${allContacts.length} em ${finalTime}ms`);
    
    res.json({ 
      success: true, 
      contacts: allContacts,
      stats: {
        totalContacts: allContacts.length,
        loadTime: finalTime,
        isComplete: true
      }
    });
  } catch (error) {
    console.error('❌ Erro ao carregar todos os contatos:', error);
    res.status(500).json({ success: false, message: 'Erro ao carregar todos os contatos', contacts: [] });
  }
});

app.get('/api/messages/:phoneNumber', requireAuth, async (req, res) => {
  try {
    const messages = await Message.find({ phoneNumber: req.params.phoneNumber })
      .sort({ timestamp: 1 })
      .limit(100);
    
    // Verificar se arquivos de mídia existem e marcar os que estão faltando
    const messagesWithMediaCheck = messages.map(message => {
      if (message.mediaUrl) {
        const filePath = path.join(__dirname, 'public', message.mediaUrl);
        const fileExists = fs.existsSync(filePath);
        
        if (!fileExists) {
          console.log(`⚠️ Arquivo de mídia não encontrado: ${message.mediaUrl}`);
          // Marcar como arquivo faltante mas manter a mensagem
          return {
            ...message.toObject(),
            mediaUrl: null,
            body: message.body || `📎 [Arquivo de mídia não disponível: ${path.basename(message.mediaUrl)}]`,
            mediaFileMissing: true
          };
        }
      }
      return message.toObject();
    });
    
    res.json({ success: true, messages: messagesWithMediaCheck });
  } catch (error) {
    console.error('❌ Erro ao listar mensagens:', error);
    res.status(500).json({ success: false, message: 'Erro ao listar mensagens' });
  }
});

// APIs do CRM
app.get('/api/client/:phoneNumber', requireAuth, async (req, res) => {
  try {
        let client = await ClientModel.findOne({ phoneNumber: req.params.phoneNumber });
      if (!client) {
        // Criar cliente automaticamente se não existir
        client = new ClientModel({
          phoneNumber: req.params.phoneNumber,
          name: req.params.phoneNumber // Nome inicial será o telefone
        });
        await client.save();
      }
    res.json({ success: true, client });
  } catch (error) {
    console.error('❌ Erro ao buscar cliente:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar cliente' });
  }
});

app.put('/api/client/:phoneNumber', requireAuth, async (req, res) => {
  try {
    console.log('📝 Dados recebidos para atualizar cliente:', JSON.stringify(req.body, null, 2));
    
    // CORREÇÃO: Buscar cliente existente primeiro para fazer merge
    let existingClient = await ClientModel.findOne({ phoneNumber: req.params.phoneNumber });
    
    if (!existingClient) {
      // Criar cliente se não existir
      existingClient = new ClientModel({
        phoneNumber: req.params.phoneNumber,
        name: req.params.phoneNumber
      });
      await existingClient.save();
      console.log('📝 Cliente criado automaticamente:', req.params.phoneNumber);
    }
    
    // Mapear campo 'value' para 'dealValue' se presente
    const updateData = { ...req.body };
    if (updateData.value !== undefined) {
      updateData.dealValue = updateData.value;
      delete updateData.value;
    }
    
    // Mapear prioridades do frontend para o schema
    if (updateData.priority) {
      const priorityMap = {
        'baixa': 'low',
        'normal': 'medium',
        'alta': 'high',
        'urgente': 'urgent'
      };
      updateData.priority = priorityMap[updateData.priority] || updateData.priority;
    }
    
    // CORREÇÃO: Fazer merge dos dados ao invés de substituir
    // Preservar dados existentes e atualizar apenas os campos enviados
    const mergedData = {
      // Manter dados existentes
      name: updateData.name || existingClient.name,
      email: updateData.email !== undefined ? updateData.email : existingClient.email,
      company: updateData.company !== undefined ? updateData.company : existingClient.company,
      position: updateData.position !== undefined ? updateData.position : existingClient.position,
      address: updateData.address !== undefined ? updateData.address : existingClient.address,
      city: updateData.city !== undefined ? updateData.city : existingClient.city,
      state: updateData.state !== undefined ? updateData.state : existingClient.state,
      zipCode: updateData.zipCode !== undefined ? updateData.zipCode : existingClient.zipCode,
      birthDate: updateData.birthDate !== undefined ? updateData.birthDate : existingClient.birthDate,
      tags: updateData.tags !== undefined ? updateData.tags : existingClient.tags,
      status: updateData.status || existingClient.status,
      priority: updateData.priority || existingClient.priority,
      source: updateData.source || existingClient.source,
      assignedTo: updateData.assignedTo !== undefined ? updateData.assignedTo : existingClient.assignedTo,
      nextFollowUp: updateData.nextFollowUp !== undefined ? updateData.nextFollowUp : existingClient.nextFollowUp,
      dealValue: updateData.dealValue !== undefined ? updateData.dealValue : existingClient.dealValue,
      dealStage: updateData.dealStage || existingClient.dealStage,
      customFields: updateData.customFields !== undefined ? updateData.customFields : existingClient.customFields,
      // Preservar notas existentes (não devem ser alteradas nesta operação)
      notes: existingClient.notes,
      // Atualizar timestamps
      updatedAt: new Date(),
      lastContact: new Date()
    };
    
    console.log('📝 Dados para merge (preservando existentes):', JSON.stringify(mergedData, null, 2));
    
    const client = await ClientModel.findOneAndUpdate(
      { phoneNumber: req.params.phoneNumber },
      { $set: mergedData },
      { new: true, upsert: false }
    );
    
    console.log('✅ Cliente salvo no banco (com merge):', JSON.stringify(client, null, 2));
    
    // Emitir evento para atualizar interface em tempo real
    io.emit('client-status-updated', {
      phoneNumber: client.phoneNumber,
      newStatus: client.status,
      reason: 'manual_update',
      timestamp: new Date().toISOString(),
      source: 'manual'
    });
    
    res.json({ success: true, client });
  } catch (error) {
    console.error('❌ Erro ao atualizar cliente:', error);
    res.status(500).json({ success: false, message: 'Erro ao atualizar cliente' });
  }
});

app.post('/api/client/:phoneNumber/note', requireAuth, async (req, res) => {
  try {
    console.log('📝 Adicionando nota para cliente:', req.params.phoneNumber);
    console.log('📝 Dados da nota:', JSON.stringify(req.body, null, 2));
    console.log('📝 Usuário logado:', req.session?.user?.username || 'N/A');
    
    const client = await ClientModel.findOne({ phoneNumber: req.params.phoneNumber });
    if (!client) {
      console.log('❌ Cliente não encontrado:', req.params.phoneNumber);
      return res.status(404).json({ success: false, message: 'Cliente não encontrado' });
    }
    
    console.log('📝 Cliente encontrado, notas atuais:', client.notes.length);
    
    const newNote = {
      text: req.body.text,
      createdBy: req.session?.user?.username || 'system',
      createdAt: new Date()
    };
    
    client.notes.push(newNote);
    console.log('📝 Nova nota adicionada:', JSON.stringify(newNote, null, 2));
    
    await client.save();
    console.log('✅ Cliente salvo com nova nota. Total de notas:', client.notes.length);
    
    res.json({ success: true, client });
  } catch (error) {
    console.error('❌ Erro ao adicionar nota:', error);
    res.status(500).json({ success: false, message: 'Erro ao adicionar nota' });
  }
});

app.put('/api/client/:phoneNumber/note/:noteIndex', requireAuth, async (req, res) => {
  try {
    const client = await ClientModel.findOne({ phoneNumber: req.params.phoneNumber });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente não encontrado' });
    }
    
    const noteIndex = parseInt(req.params.noteIndex);
    if (noteIndex < 0 || noteIndex >= client.notes.length) {
      return res.status(404).json({ success: false, message: 'Nota não encontrada' });
    }
    
    // Se texto está vazio, excluir a nota
    if (!req.body.text || !req.body.text.trim()) {
      client.notes.splice(noteIndex, 1);
    } else {
      // Atualizar a nota
      client.notes[noteIndex].text = req.body.text.trim();
      client.notes[noteIndex].updatedAt = new Date();
      client.notes[noteIndex].updatedBy = req.session.user.username;
    }
    
    await client.save();
    res.json({ success: true, client });
  } catch (error) {
    console.error('❌ Erro ao editar nota:', error);
    res.status(500).json({ success: false, message: 'Erro ao editar nota' });
  }
});

app.delete('/api/client/:phoneNumber/note/:noteIndex', requireAuth, async (req, res) => {
  try {
    const client = await ClientModel.findOne({ phoneNumber: req.params.phoneNumber });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Cliente não encontrado' });
    }
    
    const noteIndex = parseInt(req.params.noteIndex);
    if (noteIndex < 0 || noteIndex >= client.notes.length) {
      return res.status(404).json({ success: false, message: 'Nota não encontrada' });
    }
    
    client.notes.splice(noteIndex, 1);
    await client.save();
    res.json({ success: true, client });
  } catch (error) {
    console.error('❌ Erro ao remover nota:', error);
    res.status(500).json({ success: false, message: 'Erro ao remover nota' });
  }
});

// Rota para webhook n8n - Atualizar status de cliente
app.post('/api/client/update-status', async (req, res) => {
  try {
    console.log('🔄 Webhook n8n recebido para atualizar status:', JSON.stringify(req.body, null, 2));
    
    let { phoneNumber, newStatus, reason, priority, notes } = req.body;
    
    // Validar campos obrigatórios
    if (!phoneNumber || !newStatus) {
      console.log('❌ Campos obrigatórios ausentes:', { phoneNumber, newStatus });
      return res.status(400).json({ 
        success: false, 
        message: 'phoneNumber e newStatus são obrigatórios' 
      });
    }
    
    // Limpar número de telefone (remover @c.us se presente)
    let cleanPhoneNumber = phoneNumber.toString().replace('@c.us', '').replace(/\D/g, '');
    
    // Garantir que tem código do país
    if (!cleanPhoneNumber.startsWith('55') && cleanPhoneNumber.length >= 10) {
      cleanPhoneNumber = '55' + cleanPhoneNumber;
    }
    
    console.log(`📱 Número limpo: ${phoneNumber} → ${cleanPhoneNumber}`);
    
    // Validar status permitidos
    const allowedStatuses = ['novo', 'andamento', 'aprovado', 'reprovado'];
    if (!allowedStatuses.includes(newStatus)) {
      console.log('❌ Status inválido:', newStatus);
      return res.status(400).json({ 
        success: false, 
        message: `Status inválido. Permitidos: ${allowedStatuses.join(', ')}` 
      });
    }
    
    // Buscar cliente existente
    let client = await ClientModel.findOne({ phoneNumber: cleanPhoneNumber });
    
    if (!client) {
      console.log('📝 Cliente não encontrado, criando novo:', cleanPhoneNumber);
      // Criar cliente se não existir
      client = new ClientModel({
        phoneNumber: cleanPhoneNumber,
        name: cleanPhoneNumber,
        status: newStatus,
        priority: priority || 'medium',
        source: 'n8n',
        lastContact: new Date(),
        updatedAt: new Date()
      });
    } else {
      console.log(`🔄 Cliente encontrado. Status atual: ${client.status} → ${newStatus}`);
      // Atualizar cliente existente
      client.status = newStatus;
      client.priority = priority || client.priority;
      client.lastContact = new Date();
      client.updatedAt = new Date();
    }
    
    // Adicionar nota sobre a mudança de status
    const statusNote = {
      text: `🤖 Status atualizado via n8n: ${newStatus}${reason ? ` (${reason})` : ''}`,
      createdBy: 'n8n-webhook',
      createdAt: new Date()
    };
    
    if (!client.notes) {
      client.notes = [];
    }
    client.notes.push(statusNote);
    
    // Adicionar nota adicional se fornecida
    if (notes && notes.trim()) {
      const additionalNote = {
        text: notes.trim(),
        createdBy: 'n8n-webhook',
        createdAt: new Date()
      };
      client.notes.push(additionalNote);
    }
    
    // Salvar no banco
    await client.save();
    
    console.log(`✅ Status do cliente ${cleanPhoneNumber} atualizado para: ${newStatus}`);
    console.log(`📝 Notas adicionadas: ${client.notes.length} total`);
    
    // Emitir evento para atualizar frontend em tempo real
    const eventData = {
      phoneNumber: cleanPhoneNumber,
      newStatus: newStatus,
      reason: reason,
      timestamp: new Date().toISOString(),
      source: 'n8n'
    };
    console.log('🔥 EMITINDO EVENTO client-status-updated:', JSON.stringify(eventData, null, 2));
    console.log('🔥 Total de clientes conectados:', io.engine.clientsCount);
    io.emit('client-status-updated', eventData);
    
    res.json({ 
      success: true, 
      message: `Status atualizado para ${newStatus}`,
      client: {
        phoneNumber: client.phoneNumber,
        name: client.name,
        status: client.status,
        priority: client.priority,
        lastContact: client.lastContact
      }
    });
    
  } catch (error) {
    console.error('❌ Erro ao atualizar status via webhook n8n:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro interno do servidor: ' + error.message 
    });
  }
});

// Rota de teste para socket.io
app.get('/api/socket/test', (req, res) => {
  console.log('🧪 TESTE SOCKET - Emitindo evento de teste...');
  const testData = {
    phoneNumber: '556298448536',
    newStatus: 'andamento',
    reason: 'teste_socket',
    timestamp: new Date().toISOString(),
    source: 'test'
  };
  console.log('🔥 EMITINDO EVENTO DE TESTE client-status-updated:', JSON.stringify(testData, null, 2));
  console.log('🔥 Total de clientes conectados:', io.engine.clientsCount);
  io.emit('client-status-updated', testData);
  
  res.json({
    success: true,
    message: 'Evento de teste emitido',
    data: testData,
    connectedClients: io.engine.clientsCount
  });
});

// Rota de teste para webhook de atualização de status
app.get('/api/client/update-status/test', (req, res) => {
  res.json({
    success: true,
    message: 'Endpoint de atualização de status funcionando',
    timestamp: new Date().toISOString(),
    usage: {
      method: 'POST',
      url: '/api/client/update-status',
      requiredFields: ['phoneNumber', 'newStatus'],
      optionalFields: ['reason', 'priority', 'notes'],
      allowedStatuses: ['novo', 'andamento', 'aprovado', 'reprovado'],
      allowedPriorities: ['low', 'medium', 'high', 'urgent']
    },
    examples: {
      basicUpdate: {
        phoneNumber: '556298448536@c.us',
        newStatus: 'andamento',
        reason: 'cliente_demonstrou_interesse'
      },
      fullUpdate: {
        phoneNumber: '5511999999999',
        newStatus: 'aprovado',
        reason: 'proposta_aceita',
        priority: 'high',
        notes: 'Cliente aprovou proposta de R$ 5.000'
      },
      n8nFormat: {
        phoneNumber: '={{ $("Edit Fields").item.json.telefoneCliente }}',
        newStatus: 'andamento',
        reason: 'cliente_demonstrou_interesse'
      }
    }
  });
});

// Função para corrigir número baseado no DDD (backend)
function corrigirNumeroPorDDD(numeroLimpo) {
  // DDDs da região metropolitana de São Paulo que usam 9 dígitos
  const dddsComNove = ['11', '12', '13', '14', '15', '16', '17', '18', '19'];
  
  let numeroCorrigido = numeroLimpo;
  
  // Se o número tem 11 dígitos (DDD + 9 dígitos)
  if (numeroLimpo.length === 11) {
    const ddd = numeroLimpo.substring(0, 2);
    
    // Se o DDD NÃO está na lista dos que usam 9 dígitos
    if (!dddsComNove.includes(ddd)) {
      // Remove o 9º dígito (que seria o terceiro dígito do número, após o DDD)
      // Formato: DDD + 9 + 8 dígitos -> DDD + 8 dígitos
      const dddParte = numeroLimpo.substring(0, 2); // DDD
      const primeiroDígito = numeroLimpo.substring(2, 3); // Primeiro dígito após DDD
      const restoNumero = numeroLimpo.substring(3); // Resto do número
      
      // Se o primeiro dígito após o DDD é 9, remove ele
      if (primeiroDígito === '9' && restoNumero.length === 8) {
        numeroCorrigido = dddParte + restoNumero;
        console.log(`🔧 Corrigido número para DDD ${ddd}: ${numeroLimpo} → ${numeroCorrigido}`);
      }
    }
  }
  
  // Se o número tem 13 dígitos (55 + DDD + 9 dígitos)
  if (numeroLimpo.length === 13 && numeroLimpo.startsWith('55')) {
    const ddd = numeroLimpo.substring(2, 4);
    
    // Se o DDD NÃO está na lista dos que usam 9 dígitos
    if (!dddsComNove.includes(ddd)) {
      // Remove o 9º dígito
      const codigoPais = numeroLimpo.substring(0, 2); // 55
      const dddParte = numeroLimpo.substring(2, 4); // DDD
      const primeiroDígito = numeroLimpo.substring(4, 5); // Primeiro dígito após DDD
      const restoNumero = numeroLimpo.substring(5); // Resto do número
      
      // Se o primeiro dígito após o DDD é 9, remove ele
      if (primeiroDígito === '9' && restoNumero.length === 8) {
        numeroCorrigido = codigoPais + dddParte + restoNumero;
        console.log(`🔧 Corrigido número para DDD ${ddd}: ${numeroLimpo} → ${numeroCorrigido}`);
      }
    }
  }
  
  return numeroCorrigido;
}

// APIs para Disparo em Massa
app.post('/api/disparo/enviar', requireAuth, async (req, res) => {
  try {
    console.log('📥 Dados recebidos para disparo:', JSON.stringify(req.body, null, 2));
    const { contatos, mensagem, arquivo, tipoTemplate, agendarPara, intervalo } = req.body;
    
    console.log('🔍 Validando dados...');
    console.log('- Contatos:', contatos?.length || 0);
    console.log('- Mensagem:', mensagem ? 'presente' : 'ausente');
    console.log('- Arquivo:', arquivo ? 'presente' : 'ausente');
    console.log('- Tipo Template:', tipoTemplate);
    
    if (!contatos || contatos.length === 0) {
      console.log('❌ Erro: Nenhum contato selecionado');
      return res.status(400).json({ success: false, message: 'Nenhum contato selecionado' });
    }
    
    // Validar baseado no template
    if (tipoTemplate === 'texto' && (!mensagem || !mensagem.trim())) {
      console.log('❌ Erro: Mensagem obrigatória para template de texto');
      return res.status(400).json({ success: false, message: 'Mensagem é obrigatória para template de texto' });
    }
    
                if (['imagem', 'imagem-legenda', 'audio', 'arquivo', 'arquivo-legenda'].includes(tipoTemplate) && !arquivo) {
      console.log('❌ Erro: Arquivo obrigatório para template', tipoTemplate);
      return res.status(400).json({ success: false, message: 'Arquivo é obrigatório para este template' });
    }
    
    if (!isReady || !whatsappClient) {
      return res.status(400).json({ success: false, message: 'WhatsApp não conectado' });
    }

    // Marcar início do disparo em massa
    massDispatchActive.isActive = true;
    massDispatchActive.startTime = Date.now();
    massDispatchActive.endTime = null;
    massDispatchActive.sentNumbers.clear(); // Limpar números anteriores
    
    // Configurar controle de disparo
    disparoControlState.shouldStop = false;
    disparoControlState.currentDispatchId = Date.now().toString();
    disparoControlState.progress = {
      total: contatos.length,
      validated: 0,
      sent: 0,
      failed: 0,
      invalidNumbers: [],
      validationPhase: true,
      sendingPhase: false
    };
    
    console.log('🚀 DISPARO EM MASSA INICIADO - Webhook de mensagens enviadas será BLOQUEADO');
    
    const resultados = {
      total: contatos.length,
      enviados: 0,
      falharam: 0,
      detalhes: []
    };
    
    const intervaloMs = parseInt(intervalo) * 1000 || 3000; // Default 3 segundos
    
    // Função para enviar mensagem individual
    const enviarMensagem = async (contato, index) => {
      try {
        // Usar número já validado e corrigido
        const numeroCorrigido = contato.numeroCorrigido || corrigirNumeroPorDDD(contato.phoneNumber);
        const whatsappNumber = numeroCorrigido + '@c.us';
        
        if (arquivo) {
          // Enviar com arquivo baseado no template
          const MessageMedia = require('whatsapp-web.js').MessageMedia;
          const fs = require('fs');
          const path = require('path');
          
          const filePath = path.join(__dirname, 'public', arquivo);
          
          console.log('🖼️ Preparando mídia:', {
            filePath,
            tipoTemplate,
            mensagem: mensagem ? 'presente' : 'ausente'
          });
          
          const temLegenda = ['imagem-legenda', 'arquivo-legenda'].includes(tipoTemplate) && mensagem && mensagem.trim();
          
          if (temLegenda) {
            console.log('📝 Enviando mídia com legenda:', mensagem.trim());
            
            try {
              // Método que funciona: enviar mídia + texto juntos usando sendMessage com options
          const media = MessageMedia.fromFilePath(filePath);
              console.log('📄 Mídia com legenda criada:', {
                mimetype: media.mimetype,
                filename: media.filename,
                caption: mensagem.trim()
              });
              
              // Usar a API mais robusta do whatsapp-web.js
              await whatsappClient.sendMessage(whatsappNumber, media, {
                caption: mensagem.trim()
              });
              
              console.log('✅ Mídia com legenda enviada usando options.caption');
              
            } catch (mediaError) {
              console.error('❌ Erro com MessageMedia.fromFilePath (com legenda):', mediaError.message);
              
              const fs = require('fs');
              const path = require('path');
              
              // Tratamento especial para ÁUDIO COM LEGENDA
              if (tipoTemplate.includes('audio')) {
                console.log('🎵 Processando áudio com legenda usando conversão MP3...');
                
                try {
                  // Usar função de otimização
                  const optimization = optimizeAudioForWhatsApp(filePath, null);
                  
                  if (!optimization.success) {
                    throw new Error(`Otimização falhou: ${optimization.reason}`);
                  }
                  
                  const config = optimization.config;
                  console.log(`🎯 Estratégias de envio com legenda: ${config.strategies.join(' → ')}`);
                  console.log(`📊 Arquivo: ${config.fileName} (${config.fileSizeKB} KB)`);
                  console.log(`📝 Legenda: "${mensagem.trim()}"`);
                  
                  // Preparar arquivo MP3 se necessário
                  let mp3FilePath = filePath;
                  let mp3FileData = null;
                  
                  if (config.needsConversion) {
                    try {
                      const outputPath = filePath.replace(config.fileExt, '.mp3');
                      console.log(`🔄 Convertendo ${config.fileExt} para MP3 (com legenda)...`);
                      mp3FilePath = await converterAudioParaMP3(filePath, outputPath);
                      mp3FileData = fs.readFileSync(mp3FilePath).toString('base64');
                      console.log(`✅ Conversão concluída: ${path.basename(mp3FilePath)}`);
                    } catch (conversionError) {
                      console.log(`⚠️ Falha na conversão para MP3: ${conversionError.message}`);
                      console.log(`🔄 Usando arquivo original: ${config.fileName}`);
                      mp3FilePath = filePath;
                      mp3FileData = fs.readFileSync(filePath).toString('base64');
                    }
                  } else {
                    mp3FileData = fs.readFileSync(filePath).toString('base64');
                  }
                  
                  // Executar estratégias em ordem de prioridade COM LEGENDA
                  for (const strategy of config.strategies) {
                    try {
                      if (strategy === 'ptt-mp3' && mp3FileData) {
                        console.log('🎤 Tentando PTT (MP3) com legenda...');
                        
                        const mp3Media = new MessageMedia(
                          'audio/mpeg', 
                          mp3FileData, 
                          path.basename(mp3FilePath)
                        );
                        
                        // Configurações específicas para PTT com legenda
                        mp3Media.isPtt = true;
                        
                        const pttOptions = {
                          sendAudioAsVoice: true,
                          mimetype: 'audio/mp3',
                          ptt: true,
                          caption: mensagem.trim()
                        };
                        
                        await whatsappClient.sendMessage(whatsappNumber, mp3Media, pttOptions);
                        console.log('✅ Áudio PTT (MP3) enviado com legenda');
                        return;
                        
                      } else if (strategy === 'ptt-original') {
                        console.log('🎤 Tentando PTT (original) com legenda...');
                        
                        const originalData = fs.readFileSync(filePath).toString('base64');
                        const originalMedia = new MessageMedia(
                          config.preferredMime, 
                          originalData, 
                          config.fileName
                        );
                        originalMedia.isPtt = true;
                        
                        const pttOptions = {
                          sendAudioAsVoice: true,
                          ptt: true,
                          caption: mensagem.trim()
                        };
                        
                        await whatsappClient.sendMessage(whatsappNumber, originalMedia, pttOptions);
                        console.log(`✅ Áudio PTT (${config.preferredMime}) enviado com legenda`);
                        return;
                        
                      } else if (strategy === 'audio') {
                        console.log('🎵 Tentando como arquivo de áudio com legenda...');
                        
                        // Prioriza MP3 se disponível
                        const audioData = mp3FileData || fs.readFileSync(filePath).toString('base64');
                        const audioMime = mp3FileData ? 'audio/mpeg' : config.preferredMime;
                        const audioFileName = mp3FileData ? path.basename(mp3FilePath) : config.fileName;
                        
                        const audioMedia = new MessageMedia(audioMime, audioData, audioFileName);
                        
                        await whatsappClient.sendMessage(whatsappNumber, audioMedia, {
                          caption: mensagem.trim()
                        });
                        console.log(`✅ Áudio (${audioMime}) enviado com legenda`);
                        return;
                        
                      } else if (strategy === 'document') {
                        console.log('📎 Tentando como documento de áudio com legenda...');
                        
                        const docData = mp3FileData || fs.readFileSync(filePath).toString('base64');
                        const docMime = mp3FileData ? 'audio/mpeg' : config.preferredMime;
                        const docFileName = mp3FileData ? `🎵 ${path.basename(mp3FilePath)}` : `🎵 ${config.fileName}`;
                        
                        const docMedia = new MessageMedia(docMime, docData, docFileName);
                        
                        await whatsappClient.sendMessage(whatsappNumber, docMedia, {
                          caption: mensagem.trim()
                        });
                        console.log('✅ Documento de áudio enviado com legenda');
                        return;
                      }
                      
                    } catch (strategyError) {
                      console.log(`❌ Estratégia ${strategy} com legenda falhou:`, strategyError.message);
                    }
                  }
                  
                  throw new Error('Todas as estratégias de áudio com legenda falharam');
                  
                } catch (audioError) {
                  console.error('❌ Erro no processamento de áudio com legenda:', audioError.message);
                  
                  // Fallback final - enviar como mensagem de texto
                  try {
                    const audioInfo = `🎵 *${mensagem.trim()}*\n\n⚠️ O áudio foi gravado mas houve um problema técnico no envio.\n\n📁 Arquivo: ${path.basename(filePath)}\n📊 Tamanho: ${formatFileSize(fs.statSync(filePath).size)}\n\n💡 *Dica:* Tente gravar um áudio mais curto.`;
                    await whatsappClient.sendMessage(whatsappNumber, audioInfo);
                    console.log('✅ Informação sobre áudio com legenda enviada como texto');
                    return;
                  } catch (finalError) {
                    console.error('❌ Falha total no áudio com legenda:', finalError.message);
                    throw audioError;
                  }
                }
              } else {
                // Fallback para outros tipos de mídia com legenda (imagem, arquivo)
                const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
                const mimeType = getMimeTypeFromExtension(path.extname(filePath));
                
                console.log('🔄 Tentando método alternativo com legenda:', {
                  arquivo: path.basename(filePath),
                  tamanho: fs.statSync(filePath).size,
                  mimeType,
                  legenda: mensagem.trim()
                });
                
                const media = new MessageMedia(mimeType, fileData, path.basename(filePath));
                await whatsappClient.sendMessage(whatsappNumber, media, {
                  caption: mensagem.trim()
                });
                console.log('✅ Mídia com legenda enviada via método alternativo');
              }
            }
          } else {
            console.log('📷 Enviando mídia sem legenda');
            
            try {
              const media = MessageMedia.fromFilePath(filePath);
              console.log('📄 Mídia criada:', {
                mimetype: media.mimetype,
                filename: media.filename
              });
              
              // Verificar se é áudio e enviar como PTT
              if (tipoTemplate.includes('audio') && media.mimetype && media.mimetype.startsWith('audio/')) {
                console.log('🎤 Enviando áudio como mensagem de voz PTT...');
                
                // Configurar como PTT
                media.isPtt = true;
                
                const pttOptions = {
                  sendAudioAsVoice: true,
                  ptt: true
                };
                
                // Adicionar mimetype específico se for MP3
                if (media.mimetype === 'audio/mpeg' || media.mimetype === 'audio/mp3') {
                  pttOptions.mimetype = 'audio/mp3';
                }
                
                await whatsappClient.sendMessage(whatsappNumber, media, pttOptions);
                console.log('✅ Áudio enviado como mensagem de voz PTT');
              } else {
          await whatsappClient.sendMessage(whatsappNumber, media);
                console.log('✅ Mídia enviada com sucesso');
              }
              
            } catch (mediaError) {
              console.error('❌ Erro com MessageMedia.fromFilePath:', mediaError.message);
              
              const fs = require('fs');
              const path = require('path');
              const fileExtension = path.extname(filePath).toLowerCase();
              
              // Tratamento especial para arquivos de áudio - MÉTODO COM CONVERSÃO MP3
              if (tipoTemplate.includes('audio')) {
                console.log('🎵 Processando arquivo de áudio com conversão otimizada para MP3...');
                
                try {
                  // Usar função de otimização
                  const optimization = optimizeAudioForWhatsApp(filePath, null);
                  
                  if (!optimization.success) {
                    throw new Error(`Otimização falhou: ${optimization.reason}`);
                  }
                  
                  const config = optimization.config;
                  console.log(`🎯 Estratégias de envio: ${config.strategies.join(' → ')}`);
                  console.log(`📊 Arquivo: ${config.fileName} (${config.fileSizeKB} KB)`);
                  console.log(`🎵 PTT recomendado: ${config.isPttRecommended ? 'Sim' : 'Não'}`);
                  console.log(`🔄 Precisa conversão: ${config.needsConversion ? 'Sim' : 'Não'}`);
                  
                  // Preparar arquivo MP3 se necessário
                  let mp3FilePath = filePath;
                  let mp3FileData = null;
                  
                  if (config.needsConversion) {
                    try {
                      const outputPath = filePath.replace(config.fileExt, '.mp3');
                      console.log(`🔄 Convertendo ${config.fileExt} para MP3...`);
                      mp3FilePath = await converterAudioParaMP3(filePath, outputPath);
                      mp3FileData = fs.readFileSync(mp3FilePath).toString('base64');
                      console.log(`✅ Conversão concluída: ${path.basename(mp3FilePath)}`);
                    } catch (conversionError) {
                      console.log(`⚠️ Falha na conversão para MP3: ${conversionError.message}`);
                      console.log(`🔄 Usando arquivo original: ${config.fileName}`);
                      mp3FilePath = filePath;
                      mp3FileData = fs.readFileSync(filePath).toString('base64');
                    }
                  } else {
                    mp3FileData = fs.readFileSync(filePath).toString('base64');
                  }
                  
                  // Executar estratégias em ordem de prioridade
                  for (const strategy of config.strategies) {
                    try {
                      if (strategy === 'ptt-mp3' && mp3FileData) {
                        console.log('🎤 Tentando como mensagem de voz PTT (MP3)...');
                        
                        const mp3Media = new MessageMedia(
                          'audio/mpeg', 
                          mp3FileData, 
                          path.basename(mp3FilePath).replace('.mp3', '.mp3')
                        );
                        
                        // Configurações específicas para PTT
                        mp3Media.isPtt = true;
                        
                        // Opções adicionais para PTT
                        const pttOptions = {
                          sendAudioAsVoice: true,
                          mimetype: 'audio/mp3',
                          ptt: true
                        };
                        
                        await whatsappClient.sendMessage(whatsappNumber, mp3Media, pttOptions);
                        console.log('✅ Áudio enviado como mensagem de voz PTT (MP3)');
                        return;
                        
                      } else if (strategy === 'ptt-original') {
                        console.log('🎤 Tentando como mensagem de voz PTT (formato original)...');
                        
                        const originalData = fs.readFileSync(filePath).toString('base64');
                        const originalMedia = new MessageMedia(
                          config.preferredMime, 
                          originalData, 
                          config.fileName
                        );
                        originalMedia.isPtt = true;
                        
                        const pttOptions = {
                          sendAudioAsVoice: true,
                          ptt: true
                        };
                        
                        await whatsappClient.sendMessage(whatsappNumber, originalMedia, pttOptions);
                        console.log(`✅ Áudio enviado como PTT (${config.preferredMime})`);
                        return;
                        
                      } else if (strategy === 'audio') {
                        console.log('🎵 Tentando como arquivo de áudio...');
                        
                        // Prioriza MP3 se disponível
                        const audioData = mp3FileData || fs.readFileSync(filePath).toString('base64');
                        const audioMime = mp3FileData ? 'audio/mpeg' : config.preferredMime;
                        const audioFileName = mp3FileData ? path.basename(mp3FilePath) : config.fileName;
                        
                        const audioMedia = new MessageMedia(audioMime, audioData, audioFileName);
                        // NÃO definir isPtt para arquivo de áudio normal
                        
                        await whatsappClient.sendMessage(whatsappNumber, audioMedia);
                        console.log(`✅ Áudio enviado como arquivo (${audioMime})`);
                        return;
                        
                      } else if (strategy === 'document') {
                        console.log('📎 Tentando como documento de áudio...');
                        
                        const docData = mp3FileData || fs.readFileSync(filePath).toString('base64');
                        const docMime = mp3FileData ? 'audio/mpeg' : config.preferredMime;
                        const docFileName = mp3FileData ? `🎵 ${path.basename(mp3FilePath)}` : `🎵 ${config.fileName}`;
                        
                        const docMedia = new MessageMedia(docMime, docData, docFileName);
                        
                        await whatsappClient.sendMessage(whatsappNumber, docMedia);
                        console.log('✅ Áudio enviado como documento');
                        return;
                      }
                      
                    } catch (strategyError) {
                      console.log(`❌ Estratégia ${strategy} falhou:`, strategyError.message);
                    }
                  }
                  
                  throw new Error('Todas as estratégias de envio falharam');
                  
                } catch (audioError) {
                  console.error('❌ Erro total no processamento de áudio:', audioError.message);
                  
                  // Fallback final - informar o usuário
                  try {
                    const audioInfo = `🎵 *Mensagem de Áudio*\n\n⚠️ O áudio foi gravado mas houve um problema técnico no envio.\n\n📁 Arquivo: ${path.basename(filePath)}\n📊 Tamanho: ${formatFileSize(fs.statSync(filePath).size)}\n\n💡 *Dica:* Tente gravar um áudio mais curto ou use um formato diferente.`;
                    await whatsappClient.sendMessage(whatsappNumber, audioInfo);
                    console.log('✅ Informação sobre o problema de áudio enviada');
                    return;
                  } catch (finalError) {
                    console.error('❌ Falha total:', finalError.message);
                    throw audioError;
                  }
                }
              }
              
              // Fallback genérico para outros tipos
              console.log('🔄 Tentando método alternativo genérico...');
              const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
              const mimeType = getMimeTypeFromExtension(path.extname(filePath));
              
              console.log('📋 Dados do fallback:', {
                arquivo: path.basename(filePath),
                tamanho: fs.statSync(filePath).size,
                mimeType,
                extensao: path.extname(filePath)
              });
              
              const media = new MessageMedia(mimeType, fileData, path.basename(filePath));
              await whatsappClient.sendMessage(whatsappNumber, media);
              console.log('✅ Mídia enviada via método alternativo genérico');
            }
          }
        } else if (tipoTemplate === 'texto' && mensagem && mensagem.trim()) {
          // Enviar apenas texto
          await whatsappClient.sendMessage(whatsappNumber, mensagem);
        }
        
        // Salvar no banco
        let messageType = 'text';
        let messageBody = mensagem || '';
        
        if (arquivo) {
          if (tipoTemplate.includes('imagem')) {
            messageType = 'image';
          } else if (tipoTemplate.includes('audio')) {
            messageType = 'audio';
          } else {
            messageType = 'document';
          }
        }
        
        const messageDoc = new Message({
          phoneNumber: contato.phoneNumber,
          body: messageBody,
          type: messageType,
          mediaUrl: arquivo || null,
          isFromMe: true,
          timestamp: new Date()
        });
        await messageDoc.save();
        
        resultados.enviados++;
        resultados.detalhes.push({
          contato: contato.name || contato.phoneNumber,
          phoneNumber: contato.phoneNumber,
          status: 'sucesso',
          horario: new Date().toLocaleString('pt-BR')
        });
        
        // Adicionar número à lista de disparo ativo (para bloquear webhook)
        massDispatchActive.sentNumbers.add(numeroCorrigido);
        
        console.log(`✅ Disparo enviado para ${contato.name || contato.phoneNumber} (${index + 1}/${contatos.length})`);
        
      } catch (error) {
        resultados.falharam++;
        resultados.detalhes.push({
          contato: contato.name || contato.phoneNumber,
          phoneNumber: contato.phoneNumber,
          status: 'erro',
          erro: error.message,
          horario: new Date().toLocaleString('pt-BR')
        });
        
        console.error(`❌ Erro ao enviar para ${contato.name || contato.phoneNumber}:`, error.message);
      }
    };

    // Função para validar contatos antes do envio
    const validarContatos = async (listaContatos) => {
      console.log(`🔍 Iniciando validação de ${listaContatos.length} contatos...`);
      disparoControlState.progress.validationPhase = true;
      
      const contatosValidos = [];
      
      for (let i = 0; i < listaContatos.length; i++) {
        // Verificar se deve parar
        if (disparoControlState.shouldStop) {
          console.log('🛑 Validação interrompida pelo usuário');
          throw new Error('Disparo interrompido pelo usuário');
        }
        
        const contato = listaContatos[i];
        const numeroCorrigido = corrigirNumeroPorDDD(contato.phoneNumber);
        
        console.log(`🔍 Validando contato ${i + 1}/${listaContatos.length}: ${contato.name || contato.phoneNumber}`);
        
        const validacao = await validarNumeroWhatsApp(numeroCorrigido);
        
        if (validacao.valid) {
          contatosValidos.push({
            ...contato,
            numeroCorrigido,
            numberId: validacao.numberId
          });
          console.log(`✅ Contato válido: ${contato.name || contato.phoneNumber}`);
        } else {
          disparoControlState.progress.invalidNumbers.push({
            name: contato.name || 'Sem nome',
            phoneNumber: contato.phoneNumber,
            numeroCorrigido,
            error: validacao.error || 'Número não possui WhatsApp'
          });
          console.log(`❌ Contato inválido: ${contato.name || contato.phoneNumber} - ${validacao.error || 'Não tem WhatsApp'}`);
        }
        
        disparoControlState.progress.validated = i + 1;
        
        // Pequeno delay para não sobrecarregar a API do WhatsApp
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      disparoControlState.progress.validationPhase = false;
      console.log(`✅ Validação concluída: ${contatosValidos.length} válidos, ${disparoControlState.progress.invalidNumbers.length} inválidos`);
      
      return contatosValidos;
    };
    
    // Verificar se é agendamento
    if (agendarPara) {
      const agendamento = new Date(agendarPara);
      const agora = new Date();
      
      if (agendamento <= agora) {
        return res.status(400).json({ success: false, message: 'Data de agendamento deve ser futura' });
      }
      
      const delayMs = agendamento.getTime() - agora.getTime();
      
      setTimeout(async () => {
        try {
          console.log(`🕐 Iniciando disparo agendado - validação de ${contatos.length} contatos`);
          
          // Validar contatos primeiro
          const contatosValidos = await validarContatos(contatos);
          
          if (contatosValidos.length === 0) {
            console.log('❌ Nenhum contato válido encontrado');
            return;
          }
          
          console.log(`📤 Iniciando envio para ${contatosValidos.length} contatos válidos`);
          disparoControlState.progress.sendingPhase = true;
        
          for (let i = 0; i < contatosValidos.length; i++) {
            // Verificar se deve parar
            if (disparoControlState.shouldStop) {
              console.log('🛑 Envio interrompido pelo usuário');
              break;
            }
            
            await enviarMensagem(contatosValidos[i], i);
            disparoControlState.progress.sent = resultados.enviados;
            disparoControlState.progress.failed = resultados.falharam;
          
          // Intervalo entre mensagens (exceto na última)
            if (i < contatosValidos.length - 1) {
            await new Promise(resolve => setTimeout(resolve, intervaloMs));
          }
        }
        
        console.log(`🎯 Disparo agendado concluído: ${resultados.enviados} enviados, ${resultados.falharam} falharam`);
        
        } catch (error) {
          console.error('❌ Erro no disparo agendado:', error);
        } finally {
        // Marcar fim do disparo em massa
        massDispatchActive.isActive = false;
        massDispatchActive.endTime = Date.now();
          disparoControlState.progress.sendingPhase = false;
        console.log('🏁 DISPARO EM MASSA FINALIZADO - Webhook de mensagens enviadas será desbloqueado em 10 minutos');
        }
      }, delayMs);
      
      res.json({ 
        success: true, 
        message: `Disparo agendado para ${agendamento.toLocaleString('pt-BR')}`,
        agendado: true,
        contatos: contatos.length
      });
      
    } else {
      // Envio imediato
      try {
        console.log(`📤 Iniciando disparo imediato - validação de ${contatos.length} contatos`);
        
        // Validar contatos primeiro
        const contatosValidos = await validarContatos(contatos);
        
        if (contatosValidos.length === 0) {
          return res.status(400).json({ 
            success: false, 
            message: 'Nenhum contato possui WhatsApp ativo',
            invalidNumbers: disparoControlState.progress.invalidNumbers
          });
        }
        
        console.log(`📤 Iniciando envio para ${contatosValidos.length} contatos válidos`);
        disparoControlState.progress.sendingPhase = true;
      
        for (let i = 0; i < contatosValidos.length; i++) {
          // Verificar se deve parar
          if (disparoControlState.shouldStop) {
            console.log('🛑 Envio interrompido pelo usuário');
            break;
          }
          
          await enviarMensagem(contatosValidos[i], i);
          disparoControlState.progress.sent = resultados.enviados;
          disparoControlState.progress.failed = resultados.falharam;
        
        // Intervalo entre mensagens (exceto na última)
          if (i < contatosValidos.length - 1) {
          await new Promise(resolve => setTimeout(resolve, intervaloMs));
        }
      }
      
      res.json({ 
        success: true, 
          message: disparoControlState.shouldStop ? 'Disparo interrompido' : 'Disparo concluído',
          resultados,
          invalidNumbers: disparoControlState.progress.invalidNumbers,
          interrupted: disparoControlState.shouldStop
        });
        
      } catch (error) {
        console.error('❌ Erro no disparo imediato:', error);
        res.status(500).json({ 
          success: false, 
          message: 'Erro no disparo: ' + error.message,
          invalidNumbers: disparoControlState.progress.invalidNumbers
        });
      } finally {
        // Marcar fim do disparo em massa
        massDispatchActive.isActive = false;
        massDispatchActive.endTime = Date.now();
        disparoControlState.progress.sendingPhase = false;
        console.log('🏁 DISPARO EM MASSA FINALIZADO - Webhook de mensagens enviadas será desbloqueado em 10 minutos');
      }
    }
    
  } catch (error) {
    console.error('❌ Erro no disparo em massa:', error);
    res.status(500).json({ success: false, message: 'Erro no disparo: ' + error.message });
  }
});

app.get('/api/disparo/contatos', requireAuth, async (req, res) => {
  try {
    if (!isReady) {
      return res.json({ success: false, message: 'WhatsApp não conectado', contatos: [] });
    }

    const contacts = await getWhatsAppContacts();
    
    // Carregar dados do CRM para cada contato
    const contactsWithCRM = await Promise.all(
      contacts.map(async (contact) => {
        try {
          const client = await ClientModel.findOne({ phoneNumber: contact.phoneNumber });
          return {
            ...contact,
            crmData: client
          };
        } catch (error) {
          return { ...contact, crmData: null };
        }
      })
    );
    
    res.json({ success: true, contatos: contactsWithCRM });
  } catch (error) {
    console.error('❌ Erro ao listar contatos para disparo:', error);
    res.status(500).json({ success: false, message: 'Erro ao listar contatos', contatos: [] });
  }
});

// Endpoint para parar o disparo
app.post('/api/disparo/parar', requireAuth, async (req, res) => {
  try {
    disparoControlState.shouldStop = true;
    
    res.json({ 
      success: true, 
      message: 'Comando de parada enviado' 
    });
    
    console.log('🛑 Solicitação de parada do disparo recebida');
  } catch (error) {
    console.error('❌ Erro ao parar disparo:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao parar disparo: ' + error.message 
    });
  }
});

// Endpoint para verificar status do disparo
app.get('/api/disparo/status', requireAuth, async (req, res) => {
  try {
    const isActive = massDispatchActive.isActive;
    const progress = disparoControlState.progress;
    
    res.json({ 
      success: true, 
      isActive,
      progress,
      currentDispatchId: disparoControlState.currentDispatchId,
      shouldStop: disparoControlState.shouldStop
    });
  } catch (error) {
    console.error('❌ Erro ao verificar status:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao verificar status: ' + error.message 
    });
  }
});

// API para relatórios do CRM
app.get('/api/crm/reports', requireAuth, async (req, res) => {
  try {
    const clients = await ClientModel.find({});
    
    const stats = {
      total: clients.length,
      byStatus: {},
      byPriority: {},
      byDealStage: {},
      totalPipeline: 0,
      avgDealValue: 0,
      topClients: [],
      recentNotes: []
    };
    
    // Estatísticas por status
    ['novo', 'andamento', 'aprovado', 'reprovado'].forEach(status => {
      stats.byStatus[status] = clients.filter(c => c.status === status).length;
    });
    
    // Compatibilidade com status antigos
    ['lead', 'prospect', 'client', 'inactive', 'blocked'].forEach(oldStatus => {
      const newStatusMap = {
        'lead': 'novo',
        'prospect': 'andamento', 
        'client': 'aprovado',
        'inactive': 'reprovado',
        'blocked': 'reprovado'
      };
      const newStatus = newStatusMap[oldStatus];
      if (newStatus) {
        stats.byStatus[newStatus] += clients.filter(c => c.status === oldStatus).length;
      }
    });
    
    // Estatísticas por prioridade
    ['low', 'medium', 'high', 'urgent'].forEach(priority => {
      stats.byPriority[priority] = clients.filter(c => c.priority === priority).length;
    });
    
    // Estatísticas por estágio do negócio
    ['prospecting', 'qualification', 'proposal', 'negotiation', 'closed-won', 'closed-lost'].forEach(stage => {
      stats.byDealStage[stage] = clients.filter(c => c.dealStage === stage).length;
    });
    
    // Pipeline total e média
    const dealsWithValue = clients.filter(c => c.dealValue && c.dealValue > 0);
    stats.totalPipeline = dealsWithValue.reduce((sum, c) => sum + c.dealValue, 0);
    stats.avgDealValue = dealsWithValue.length > 0 ? stats.totalPipeline / dealsWithValue.length : 0;
    
    // Top clientes por valor
    stats.topClients = clients
      .filter(c => c.dealValue > 0)
      .sort((a, b) => b.dealValue - a.dealValue)
      .slice(0, 10)
      .map(c => ({
        name: c.name,
        phoneNumber: c.phoneNumber,
        company: c.company,
        dealValue: c.dealValue,
        status: c.status
      }));
    
    // Notas recentes
    const allNotes = [];
    clients.forEach(client => {
      if (client.notes && client.notes.length > 0) {
        client.notes.forEach(note => {
          allNotes.push({
            ...note.toObject(),
            clientName: client.name,
            clientPhone: client.phoneNumber
          });
        });
      }
    });
    
    stats.recentNotes = allNotes
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20);
    
    res.json({ success: true, stats });
  } catch (error) {
    console.error('❌ Erro ao gerar relatório:', error);
    res.status(500).json({ success: false, message: 'Erro ao gerar relatório' });
  }
});

app.post('/api/send-message', requireAuth, async (req, res) => {
  try {
    const { phoneNumber, message, fileUrl, fileType } = req.body;
    
    if (!isReady) {
      return res.status(400).json({ success: false, message: 'WhatsApp não conectado' });
    }
    
    if (!phoneNumber || (!message && !fileUrl)) {
      return res.status(400).json({ success: false, message: 'Campos obrigatórios' });
    }
    
    let formattedNumber = phoneNumber.replace(/\D/g, '');
    if (!formattedNumber.startsWith('55')) {
      formattedNumber = '55' + formattedNumber;
    }
    const whatsappNumber = formattedNumber + '@c.us';
    
    let messageDoc;
    
    // Enviar arquivo se fornecido
    if (fileUrl) {
      const filePath = path.join(__dirname, 'public', fileUrl);
      
      if (!fs.existsSync(filePath)) {
        return res.status(400).json({ success: false, message: 'Arquivo não encontrado' });
      }
      
      try {
        // Verificar tamanho do arquivo (limite do WhatsApp)
        const stats = fs.statSync(filePath);
        const fileSizeInMB = stats.size / (1024 * 1024);
        
        if (fileSizeInMB > 64) {
          return res.status(400).json({ 
            success: false, 
            message: 'Arquivo muito grande para WhatsApp (máx 64MB)' 
          });
        }
        
        console.log(`📎 Preparando envio: ${path.basename(filePath)} (${fileSizeInMB.toFixed(2)}MB)`);
        
        // Criar mídia com validação e detecção de problemas
        let media;
        let isProblematicFile = false;
        
        try {
          media = MessageMedia.fromFilePath(filePath);
          
          // Validar se a mídia foi criada corretamente
          if (!media || !media.data) {
            throw new Error('Falha ao processar arquivo de mídia');
          }
          
          // Se for PTT (mensagem de voz), usar configuração mínima (como no disparo)
          if (fileType === 'ptt') {
            console.log('🎤 Configurando como mensagem de voz (PTT) - método disparo');
            
            // Configuração mínima - deixar o WhatsApp Web decidir o melhor formato
            // (não forçar mimetype aqui, será definido nas pttOptions)
            
            console.log(`🎤 PTT configurado para usar pttOptions: ${media.mimetype}, arquivo: ${media.filename}`);
            
          } else {
            // Detectar arquivos problemáticos para outros tipos
            isProblematicFile = isProblematicForWhatsApp(filePath, stats.size);
            
            if (isProblematicFile) {
              console.log('⚠️ Arquivo problemático detectado, usando estratégias alternativas');
            }
          }
          
          // Adicionar legenda se fornecida
          if (message && message.trim()) {
            media.caption = message.trim();
          }
          
          // Definir nome do arquivo
          media.filename = path.basename(filePath);
          
        } catch (mediaError) {
          console.error('❌ Erro ao criar mídia:', mediaError);
          return res.status(400).json({ 
            success: false, 
            message: 'Erro ao processar arquivo: ' + mediaError.message 
          });
        }
        
        // Tentar enviar com estratégias diferentes
        let sendSuccess = false;
        let lastError = null;
        
        // Para PTT, usar estratégia específica robusta
        if (fileType === 'ptt') {
          // Verificar se o cliente está realmente conectado
          try {
            const clientState = await whatsappClient.getState();
            if (clientState !== 'CONNECTED') {
              throw new Error(`WhatsApp não conectado (estado: ${clientState})`);
            }
          } catch (stateError) {
            console.log(`⚠️ Erro ao verificar estado do WhatsApp: ${stateError.message}`);
          }
          
          // Usar a estratégia completa do disparo que funciona com múltiplos fallbacks
          console.log('🎵 Processando arquivo de áudio com estratégias do disparo...');
          
          try {
            // Usar função de otimização do disparo
            const optimization = optimizeAudioForWhatsApp(filePath, null);
            
            if (!optimization.success) {
              throw new Error(`Otimização falhou: ${optimization.reason}`);
            }
            
            const config = optimization.config;
            console.log(`🎯 Estratégias de envio: ${config.strategies.join(' → ')}`);
            console.log(`📊 Arquivo: ${config.fileName} (${config.fileSizeKB} KB)`);
            console.log(`🎵 PTT recomendado: ${config.isPttRecommended ? 'Sim' : 'Não'}`);
            console.log(`🔄 Precisa conversão: ${config.needsConversion ? 'Sim' : 'Não'}`);
            
            // Preparar arquivo MP3 se necessário
            let mp3FilePath = filePath;
            let mp3FileData = null;
            
            if (config.needsConversion) {
              try {
                const outputPath = filePath.replace(config.fileExt, '.mp3');
                console.log(`🔄 Convertendo ${config.fileExt} para MP3...`);
                mp3FilePath = await converterAudioParaMP3(filePath, outputPath);
                mp3FileData = fs.readFileSync(mp3FilePath).toString('base64');
                console.log(`✅ Conversão concluída: ${path.basename(mp3FilePath)}`);
              } catch (conversionError) {
                console.log(`⚠️ Falha na conversão para MP3: ${conversionError.message}`);
                console.log(`🔄 Usando arquivo original: ${config.fileName}`);
                mp3FilePath = filePath;
                mp3FileData = fs.readFileSync(filePath).toString('base64');
              }
            } else {
              mp3FileData = fs.readFileSync(filePath).toString('base64');
            }
            
            // Executar estratégias em ordem de prioridade
            for (const strategy of config.strategies) {
              try {
                if (strategy === 'ptt-mp3' && mp3FileData) {
                  console.log('🎤 Tentando como mensagem de voz PTT (MP3)...');
                  
                    const mp3Media = new MessageMedia(
                      'audio/mpeg', 
                      mp3FileData, 
                    path.basename(mp3FilePath).replace('.mp3', '.mp3')
                    );
                    
                  // Configurações específicas para PTT
                    mp3Media.isPtt = true;
                    
                  // Opções adicionais para PTT
                    const pttOptions = {
                      sendAudioAsVoice: true,
                      mimetype: 'audio/mp3',
                      ptt: true
                    };
                    
                    console.log('🌐 Definindo flag isPageChatSending para áudio PTT');
                    isPageChatSending = true;
                    const sentMessage = await whatsappClient.sendMessage(whatsappNumber, mp3Media, pttOptions);
                    
                    // Adicionar ID da mensagem ao controle de mensagens da página de chat
                    if (sentMessage && sentMessage.id && sentMessage.id._serialized) {
                      chatPageMessageIds.add(sentMessage.id._serialized);
                    }
                    
                    // Resetar flag após um pequeno delay para garantir que o evento message_create seja bloqueado
                    setTimeout(() => {
                      console.log('🌐 Resetando flag isPageChatSending após timeout (áudio PTT)');
                      isPageChatSending = false;
                    }, 1000);
                    
                  console.log('✅ Áudio enviado como mensagem de voz PTT (MP3)');
                    sendSuccess = true;
                  break;
                  
                } else if (strategy === 'ptt-original') {
                  console.log('🎤 Tentando como mensagem de voz PTT (formato original)...');
                
                const originalData = fs.readFileSync(filePath).toString('base64');
                const originalMedia = new MessageMedia(
                    config.preferredMime, 
                  originalData, 
                    config.fileName
                );
                originalMedia.isPtt = true;
                
                const pttOptions = {
                  sendAudioAsVoice: true,
                  ptt: true
                };
                
                await whatsappClient.sendMessage(whatsappNumber, originalMedia, pttOptions);
                  console.log(`✅ Áudio enviado como PTT (${config.preferredMime})`);
                sendSuccess = true;
                  break;
                  
                } else if (strategy === 'audio') {
                  console.log('🎵 Tentando como arquivo de áudio...');
                  
                  // Prioriza MP3 se disponível
                  const audioData = mp3FileData || fs.readFileSync(filePath).toString('base64');
                  const audioMime = mp3FileData ? 'audio/mpeg' : config.preferredMime;
                  const audioFileName = mp3FileData ? path.basename(mp3FilePath) : config.fileName;
                  
                  const audioMedia = new MessageMedia(audioMime, audioData, audioFileName);
                  // NÃO definir isPtt para arquivo de áudio normal
                  
                  await whatsappClient.sendMessage(whatsappNumber, audioMedia);
                  console.log(`✅ Áudio enviado como arquivo (${audioMime})`);
                sendSuccess = true;
                  break;
                }
                
              } catch (strategyError) {
                console.log(`❌ Estratégia ${strategy} falhou:`, strategyError.message);
                lastError = strategyError;
              }
            }
            
            if (!sendSuccess) {
              throw new Error('Todas as estratégias de envio falharam');
            }
            
          } catch (audioError) {
            console.error('❌ Erro total no processamento de áudio:', audioError.message);
            lastError = audioError;
          }
        } else {
          // Estratégia 1: Sempre tentar como mídia visual primeiro (para não-PTT)
          try {
            console.log(`📤 Enviando como mídia visual para ${phoneNumber}`);
            console.log('🌐 Definindo flag isPageChatSending para mídia visual');
            isPageChatSending = true;
            const sentMessage = await whatsappClient.sendMessage(whatsappNumber, media);
            
            // Adicionar ID da mensagem ao controle de mensagens da página de chat
            if (sentMessage && sentMessage.id && sentMessage.id._serialized) {
              chatPageMessageIds.add(sentMessage.id._serialized);
            }
            
            // Resetar flag após um pequeno delay para garantir que o evento message_create seja bloqueado
            setTimeout(() => {
              console.log('🌐 Resetando flag isPageChatSending após timeout (mídia visual)');
              isPageChatSending = false;
            }, 1000);
            
            sendSuccess = true;
            console.log(`✅ Arquivo enviado como mídia visual: ${path.basename(filePath)}`);
          } catch (error) {
            lastError = error;
            console.log(`⚠️ Falha ao enviar como mídia visual: ${error.message}`);
            
            // Se for erro "Evaluation failed", tentar estratégias alternativas
            if (error.message && error.message.includes('Evaluation failed')) {
              console.log(`🔄 Erro "Evaluation failed" detectado - tentando método alternativo`);
            }
          }
        }
        
        // Estratégia 2: Tentar como mídia visual com método manual (não aplicável para PTT)
        if (!sendSuccess && fileType !== 'ptt') {
          try {
            console.log(`📤 Tentando mídia visual com método manual para ${phoneNumber}`);
            
            const fileBuffer = fs.readFileSync(filePath);
            const fileBase64 = fileBuffer.toString('base64');
            const ext = path.extname(filePath).toLowerCase();
            
            // Determinar mimetype correto para visualização
            let visualMimetype = media.mimetype;
            if (ext === '.mp4') visualMimetype = 'video/mp4';
            else if (ext === '.mov') visualMimetype = 'video/quicktime';
            else if (ext === '.webm') visualMimetype = 'video/webm';
            else if (ext === '.jpg' || ext === '.jpeg') visualMimetype = 'image/jpeg';
            else if (ext === '.png') visualMimetype = 'image/png';
            else if (ext === '.gif') visualMimetype = 'image/gif';
            
            const manualMedia = new MessageMedia(visualMimetype, fileBase64, path.basename(filePath));
            
            if (message && message.trim()) {
              manualMedia.caption = message.trim();
            }
            
            await whatsappClient.sendMessage(whatsappNumber, manualMedia);
            sendSuccess = true;
            console.log(`✅ Arquivo enviado como mídia visual manual: ${path.basename(filePath)}`);
            
          } catch (error) {
            lastError = error;
            console.log(`⚠️ Falha ao enviar mídia visual manual: ${error.message}`);
          }
        }
        
        // Estratégia 3: Enviar como documento se mídia falhou (não aplicável para PTT)
        if (!sendSuccess && fileType !== 'ptt') {
          try {
            console.log(`📤 Tentando enviar como documento para ${phoneNumber}`);
            
            // Criar documento de forma mais simples
            const fileBuffer = fs.readFileSync(filePath);
            const fileBase64 = fileBuffer.toString('base64');
            
            const documentMedia = new MessageMedia('application/octet-stream', fileBase64, path.basename(filePath));
            
            // Adicionar apenas mensagem como texto separado se fornecida
            if (message && message.trim()) {
              await whatsappClient.sendMessage(whatsappNumber, `📎 ${message.trim()}`);
            }
            
            await whatsappClient.sendMessage(whatsappNumber, documentMedia);
            sendSuccess = true;
            console.log(`✅ Arquivo enviado como documento: ${path.basename(filePath)}`);
            
          } catch (error) {
            lastError = error;
            console.log(`⚠️ Falha ao enviar como documento: ${error.message}`);
            
            // Esta seção foi removida pois já temos estratégia melhor acima
          }
        }
        
        // Estratégia 4: Enviar apenas texto se arquivo falhou (não aplicável para PTT)
        if (!sendSuccess && fileType !== 'ptt' && message && message.trim()) {
          try {
            console.log(`📤 Enviando apenas texto para ${phoneNumber}`);
            const textMessage = `${message.trim()}\n\n⚠️ Não foi possível enviar o arquivo "${path.basename(filePath)}" (${formatFileSize(stats.size)}). Por favor, tente um formato diferente ou arquivo menor.`;
            
            await whatsappClient.sendMessage(whatsappNumber, textMessage);
            sendSuccess = true;
            console.log(`✅ Mensagem de texto enviada com aviso sobre arquivo`);
            
          } catch (error) {
            lastError = error;
            console.log(`❌ Falha até mesmo ao enviar texto: ${error.message}`);
          }
        }
        
        // Se nada funcionou, lançar erro
        if (!sendSuccess) {
          if (fileType === 'ptt') {
            throw new Error(`Falha ao enviar mensagem de voz: ${lastError?.message || 'Erro desconhecido'}`);
          } else {
            throw new Error(`Todas as estratégias de envio falharam. Último erro: ${lastError?.message || 'Erro desconhecido'}`);
          }
        }
        
        // Salvar mensagem no banco
        messageDoc = new Message({
          phoneNumber: phoneNumber,
          body: message || '',
          type: fileType === 'ptt' ? 'ptt' : (fileType || 'document'),
          mediaUrl: fileUrl,
          isFromMe: true,
          timestamp: new Date()
        });
        
        // Enviar webhook centralizado para arquivo enviado pela página de chat
        await sendCentralizedWebhook('message_sent_chat', {
          author: myWhatsAppNumber,
          to: phoneNumber + '@c.us'
        });
        
      } catch (fileError) {
        console.error('❌ Erro ao processar/enviar arquivo:', fileError);
        return res.status(500).json({ 
          success: false, 
          message: 'Erro ao enviar arquivo: ' + fileError.message 
        });
      }
      
    } else {
      // Enviar mensagem de texto
      console.log('🌐 Definindo flag isPageChatSending para mensagem de texto');
      isPageChatSending = true;
      const sentMessage = await whatsappClient.sendMessage(whatsappNumber, message);
      
      // Adicionar ID da mensagem ao controle de mensagens da página de chat
      if (sentMessage && sentMessage.id && sentMessage.id._serialized) {
        chatPageMessageIds.add(sentMessage.id._serialized);
      }
      
      // Resetar flag após um pequeno delay para garantir que o evento message_create seja bloqueado
      setTimeout(() => {
        console.log('🌐 Resetando flag isPageChatSending após timeout (mensagem de texto)');
        isPageChatSending = false;
      }, 1000);
      
      messageDoc = new Message({
        phoneNumber: phoneNumber,
        body: message,
        type: 'text',
        isFromMe: true,
        timestamp: new Date()
      });
      
      console.log(`📤 Mensagem enviada para ${phoneNumber}: ${message}`);
    }
    
    await messageDoc.save();
    
    // Emitir evento Socket.IO para atualizar interface em tempo real
    const eventData = {
      contactId: phoneNumber,
      contact: {
        _id: phoneNumber,
        phoneNumber: phoneNumber,
        name: phoneNumber,
        profilePic: null
      },
      message: {
        _id: messageDoc._id,
        phoneNumber: phoneNumber,
        messageId: messageDoc.messageId || messageDoc._id?.toString(),
        body: messageDoc.body,
        type: messageDoc.type,
        mediaUrl: messageDoc.mediaUrl,
        isFromMe: true,
        timestamp: messageDoc.timestamp,
        chatId: whatsappNumber
      }
    };

    io.emit('new-message', eventData);
    
    // Enviar webhook centralizado para mensagem enviada pela página de chat
    await sendCentralizedWebhook('message_sent_chat', {
      author: myWhatsAppNumber,
      to: phoneNumber + '@c.us'
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error);
    // Resetar flag em caso de erro
    console.log('🌐 Resetando flag isPageChatSending devido a erro');
    isPageChatSending = false;
    res.status(500).json({ success: false, message: 'Erro ao enviar mensagem' });
  }
});

app.post('/api/contacts/:phoneNumber/read', requireAuth, async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    
    // Marcar mensagens como lidas no WhatsApp se possível
    if (isReady && whatsappClient) {
      try {
        const chats = await whatsappClient.getChats();
        const targetChat = chats.find(chat => {
          return chat.id.user === phoneNumber || chat.id._serialized.includes(phoneNumber);
        });
        
        if (targetChat && targetChat.unreadCount > 0) {
          await targetChat.sendSeen();
          console.log(`👁️ Mensagens marcadas como lidas para ${phoneNumber}`);
        }
      } catch (whatsappError) {
        console.log('⚠️ Não foi possível marcar como lida no WhatsApp:', whatsappError.message);
      }
    }
    
    // Emitir evento para atualizar contador na interface
    io.emit('messages-read', { phoneNumber });
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro ao marcar mensagens como lidas:', error);
    res.status(500).json({ success: false });
  }
});

// Limpar conversas do chat
app.delete('/api/messages/clear', requireAuth, async (req, res) => {
  try {
    const { phoneNumber, clearAll } = req.body;
    
    if (clearAll) {
      // Limpar todas as conversas
      const result = await Message.deleteMany({});
      console.log(`🗑️ Todas as conversas foram limpas: ${result.deletedCount} mensagens removidas`);
      
      // Emitir evento para atualizar a interface
      io.emit('conversations-cleared', { all: true });
      
      res.json({ 
        success: true, 
        message: `${result.deletedCount} mensagens removidas de todas as conversas`,
        deletedCount: result.deletedCount
      });
    } else if (phoneNumber) {
      // Limpar conversa específica
      const result = await Message.deleteMany({ phoneNumber });
      console.log(`🗑️ Conversa com ${phoneNumber} foi limpa: ${result.deletedCount} mensagens removidas`);
      
      // Emitir evento para atualizar a interface
      io.emit('conversation-cleared', { phoneNumber });
      
      res.json({ 
        success: true, 
        message: `${result.deletedCount} mensagens removidas da conversa`,
        deletedCount: result.deletedCount
      });
    } else {
      res.status(400).json({ 
        success: false, 
        message: 'Parâmetro phoneNumber ou clearAll é obrigatório' 
      });
    }
    
  } catch (error) {
    console.error('❌ Erro ao limpar conversas:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro ao limpar conversas: ' + error.message 
    });
  }
});

// =================== ROTAS DE INTEGRAÇÃO ===================

// Carregar configurações de integração
app.get('/api/integrations', requireAuth, async (req, res) => {
  try {
    // Recarregar do banco para garantir dados atualizados
    await loadIntegrationsFromDB();
    
    // Buscar informações adicionais do banco
    const dbConfig = await Integration.findOne({ key: 'main' });
    
    res.json({ 
      success: true, 
      integrations: integrationsConfig,
      metadata: dbConfig ? {
        updatedAt: dbConfig.updatedAt,
        updatedBy: dbConfig.updatedBy
      } : null
    });
  } catch (error) {
    console.error('❌ Erro ao carregar integrações:', error);
    res.json({ success: true, integrations: integrationsConfig }); // Fallback para cache
  }
});

// Histórico de configurações de integração
app.get('/api/integrations/history', requireAuth, async (req, res) => {
  try {
    const history = await Integration.find({ key: 'main' })
      .sort({ updatedAt: -1 })
      .limit(10)
              .select('n8nTestUrl n8nProdUrl n8nSentUrl iaEnabled massDispatchBypass useTestUrl updatedAt updatedBy');
    
    res.json({ success: true, history });
  } catch (error) {
    console.error('❌ Erro ao buscar histórico:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar histórico' });
  }
});

// Salvar configurações de integração
app.post('/api/integrations', requireAuth, async (req, res) => {
  try {
    const { n8nTestUrl, n8nProdUrl, n8nSentUrl, webhookReceiveUrl, iaEnabled, massDispatchBypass, useTestUrl } = req.body;
    
    const newConfig = {
      n8nTestUrl: n8nTestUrl || '',
      n8nProdUrl: n8nProdUrl || '',
      n8nSentUrl: n8nSentUrl || '',
      webhookReceiveUrl: webhookReceiveUrl || '',
      iaEnabled: Boolean(iaEnabled),
      massDispatchBypass: Boolean(massDispatchBypass),
      useTestUrl: Boolean(useTestUrl)
    };
    
    // Salvar no banco de dados
    await saveIntegrationsToDB(newConfig, req.session.user?.username || 'Guilherme');
    
    // Atualizar cache em memória
    integrationsConfig = newConfig;
    
    console.log('🔗 Configurações de integração atualizadas:', integrationsConfig);
    res.json({ success: true, message: 'Configurações salvas com sucesso no banco de dados!' });
  } catch (error) {
    console.error('❌ Erro ao salvar integrações:', error);
    res.status(500).json({ success: false, message: 'Erro ao salvar configurações: ' + error.message });
  }
});

// Testar webhook n8n
app.post('/api/integrations/test', requireAuth, async (req, res) => {
  try {
    const { url, type, testData } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, message: 'URL não fornecida' });
    }
    
    console.log(`🧪 Testando webhook ${type}: ${url}`);
    
    const axios = require('axios');
    const response = await axios.post(url, testData, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Clerky-CRM-Webhook-Test'
      }
    });
    
    console.log(`✅ Teste de webhook ${type} bem-sucedido:`, response.status);
    
    res.json({
      success: true,
      message: `Webhook ${type} respondeu com status ${response.status}`,
      response: {
        status: response.status,
        statusText: response.statusText,
        data: response.data
      }
    });
    
  } catch (error) {
    console.error(`❌ Erro no teste de webhook:`, error.message);
    
    let errorMessage = 'Erro desconhecido';
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Conexão recusada - verifique se a URL está acessível';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Timeout - servidor demorou para responder';
    } else if (error.response) {
      errorMessage = `Servidor respondeu com erro ${error.response.status}: ${error.response.statusText}`;
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.json({
      success: false,
      message: errorMessage,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      } : null
    });
  }
});

// Webhook para receber respostas do n8n - ENVIAR E SALVAR NO BANCO
app.post('/webhook/n8n/receive', async (req, res) => {
  try {
    console.log('📨 Resposta do n8n recebida - ENVIANDO E SALVANDO');
    
    // Extrair dados básicos
    let phoneNumber, message, audio, mediaType, mediaUrl, fileName, mimeType, caption;
    
    if (req.body.wa_id) {
      phoneNumber = req.body.wa_id;
      message = req.body.output || req.body.caption || req.body.message;
      audio = req.body.audio;
      mediaType = req.body.type;
      mediaUrl = req.body.video_url || req.body.image_url || req.body.audio_url || req.body.document_url;
      fileName = req.body.file_name;
      mimeType = req.body.mime_type;
      caption = req.body.caption;
    } else if (req.body.phoneNumber && req.body.message) {
      phoneNumber = req.body.phoneNumber;
      message = req.body.message;
    } else {
      return res.status(400).json({ 
        success: false, 
        message: 'Dados inválidos - wa_id é obrigatório' 
      });
    }
    
    if (!phoneNumber || (!message && !audio && !mediaUrl)) {
      return res.status(400).json({ 
        success: false, 
        message: 'phoneNumber e (message, audio ou mediaUrl) são obrigatórios' 
      });
    }
    
    // Verificar se o WhatsApp está conectado
    if (!isReady || !whatsappClient) {
      return res.status(503).json({ success: false, message: 'WhatsApp não conectado' });
    }
    
    // Formatar número para WhatsApp
    let formattedNumber = phoneNumber.replace(/\D/g, '');
    if (!formattedNumber.startsWith('55')) {
      formattedNumber = '55' + formattedNumber;
    }
    const whatsappNumber = formattedNumber + '@c.us';
    
    try {
      // Definir flag para bloquear webhooks durante envio de resposta do n8n
      isN8nResponseSending = true;
      
      // Enviar mensagem (texto, áudio ou mídia) - SEM PROCESSAMENTO ADICIONAL
      if (audio && audio.trim()) {
        // Enviar áudio
        const audioBuffer = Buffer.from(audio.startsWith('data:audio/') ? audio.split(',')[1] : audio, 'base64');
          const { MessageMedia } = require('whatsapp-web.js');
        const audioMedia = new MessageMedia('audio/mpeg', audioBuffer.toString('base64'), `audio_${Date.now()}.mp3`);
          
        await whatsappClient.sendMessage(whatsappNumber, audioMedia, { sendAudioAsVoice: true });
        console.log('✅ Áudio do n8n enviado');
      } else if (mediaUrl && mediaType) {
        // Enviar mídia (vídeo, imagem, documento)
        console.log(`📤 Enviando mídia do n8n: ${mediaType} - ${fileName}`);
        
        const axios = require('axios');
        const { MessageMedia } = require('whatsapp-web.js');
        
        // Baixar mídia da URL
        const mediaResponse = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',
          timeout: 30000
        });
        
        const mediaBuffer = Buffer.from(mediaResponse.data);
        const mediaBase64 = mediaBuffer.toString('base64');
        
        // Criar MessageMedia baseado no tipo
        let media;
        switch (mediaType.toLowerCase()) {
          case 'video':
            media = new MessageMedia('video/mp4', mediaBase64, fileName || `video_${Date.now()}.mp4`);
            break;
          case 'image':
            media = new MessageMedia('image/jpeg', mediaBase64, fileName || `image_${Date.now()}.jpg`);
            break;
          case 'audio':
            media = new MessageMedia('audio/mpeg', mediaBase64, fileName || `audio_${Date.now()}.mp3`);
            break;
          case 'document':
            media = new MessageMedia(mimeType || 'application/octet-stream', mediaBase64, fileName || `document_${Date.now()}`);
            break;
          default:
            media = new MessageMedia(mimeType || 'application/octet-stream', mediaBase64, fileName || `file_${Date.now()}`);
        }
        
        // Enviar mídia com caption se fornecido
        if (caption && caption.trim()) {
          await whatsappClient.sendMessage(whatsappNumber, media, { caption: caption });
          console.log(`✅ ${mediaType} do n8n enviado com caption`);
        } else {
          await whatsappClient.sendMessage(whatsappNumber, media);
          console.log(`✅ ${mediaType} do n8n enviado`);
        }
          } else {
        // Enviar texto
        await whatsappClient.sendMessage(whatsappNumber, message);
        console.log('✅ Texto do n8n enviado');
      }
      
      // Salvar mensagem no banco de dados
      const messageDoc = new Message({
        phoneNumber: formattedNumber,
        messageId: `n8n-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        body: audio ? '[Áudio do n8n]' : (mediaUrl ? `[${mediaType} do n8n]` : message),
        type: audio ? 'audio' : (mediaUrl ? mediaType : 'text'),
        mediaUrl: mediaUrl || null,
        isFromMe: true,
        timestamp: new Date(),
        chatId: whatsappNumber,
        fromN8n: true,
        n8nSource: 'sistema'
      });

      await messageDoc.save();
      console.log('💾 Mensagem do n8n salva no banco de dados');

      // Emitir evento Socket.IO para atualizar interface em tempo real
      const eventData = {
        contactId: formattedNumber,
        contact: {
          _id: formattedNumber,
          phoneNumber: formattedNumber,
          name: formattedNumber,
          profilePic: null
        },
        message: {
          _id: messageDoc._id,
          phoneNumber: formattedNumber,
          messageId: messageDoc.messageId,
          body: messageDoc.body,
          type: messageDoc.type,
          isFromMe: true,
          timestamp: messageDoc.timestamp,
          chatId: whatsappNumber
        }
      };

      io.emit('new-message', eventData);
      
      // Resetar flag após um pequeno delay para garantir que o evento message_create seja bloqueado
      setTimeout(() => {
        console.log('🔄 Resetando flag isN8nResponseSending após envio de resposta do n8n');
        isN8nResponseSending = false;
      }, 1000);
      
      // Retornar sucesso COM SALVAMENTO
      res.json({ 
        success: true, 
        message: 'Enviado e salvo com sucesso'
      });
      
    } catch (whatsappError) {
      console.error('❌ Erro ao enviar via WhatsApp:', whatsappError);
      // Resetar flag em caso de erro
      isN8nResponseSending = false;
      res.status(500).json({ 
        success: false, 
        message: 'Erro ao enviar: ' + whatsappError.message 
      });
    }
    
  } catch (error) {
    console.error('❌ Erro no webhook n8n:', error);
    res.status(500).json({ success: false, message: 'Erro interno do servidor' });
  }
});

// Endpoint para testar webhook do n8n
app.get('/webhook/n8n/test', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint funcionando',
    timestamp: new Date().toISOString(),
    expectedFormat: {
      method: 'POST',
      url: '/webhook/n8n/receive',
      body: {
        wa_id: 'numero_whatsapp_sem_caracteres_especiais',
        output: 'mensagem_de_texto_da_ia',
        source: 'sistema',
        audio: 'dados_base64_do_audio_opcional',
        type: 'video|image|audio|document',
        video_url: 'url_do_video',
        image_url: 'url_da_imagem',
        audio_url: 'url_do_audio',
        document_url: 'url_do_documento',
        file_name: 'nome_do_arquivo',
        mime_type: 'tipo_mime',
        caption: 'legenda_opcional'
      }
    },
    examples: {
      textMessage: {
        wa_id: '5511999999999',
        output: 'Olá! Esta é uma resposta da IA.',
        source: 'sistema'
      },
      audioMessage: {
        wa_id: '5511999999999',
        output: 'Resposta em áudio',
        source: 'sistema',
        audio: 'base64_encoded_audio_data'
      },
      videoMessage: {
        wa_id: '556298448536@c.us',
        type: 'video',
        video_url: 'https://cacursos.clerky.com.br/uploads/1752593922700-csnf1mmia.mp4',
        file_name: '1752593922700-csnf1mmia.mp4',
        mime_type: 'video/mp4',
        caption: 'Vídeo enviado automaticamente via N8N'
      },
      imageMessage: {
        wa_id: '556298448536@c.us',
        type: 'image',
        image_url: 'https://exemplo.com/imagem.jpg',
        file_name: 'imagem.jpg',
        mime_type: 'image/jpeg',
        caption: 'Imagem enviada via N8N'
      },
      documentMessage: {
        wa_id: '556298448536@c.us',
        type: 'document',
        document_url: 'https://exemplo.com/documento.pdf',
        file_name: 'documento.pdf',
        mime_type: 'application/pdf',
        caption: 'Documento enviado via N8N'
      }
    }
  });
});

// ========== ROTAS DA API APPMAX ==========

// Webhook para receber dados da AppMax
app.post('/webhook/appmax/receive', async (req, res) => {
  try {
    console.log('📨 Webhook AppMax recebido:', JSON.stringify(req.body, null, 2));
    
    // Verificar se AppMax está habilitado
    if (!integrationsConfig.appmaxEnabled) {
      console.log('❌ AppMax desabilitado, ignorando webhook');
      return res.status(200).json({ 
        success: false, 
        message: 'AppMax integration disabled' 
      });
    }
    
    // Verificar secret se configurado
    const receivedSecret = req.headers['x-appmax-signature'] || req.headers['authorization'];
    if (integrationsConfig.appmaxWebhookSecret && receivedSecret !== integrationsConfig.appmaxWebhookSecret) {
      console.log('❌ Secret do webhook AppMax inválido');
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid webhook secret' 
      });
    }
    
    // Processar dados do webhook da AppMax
    const webhookData = req.body;
    
    // Exemplo de estrutura esperada da AppMax (ajustar conforme necessário):
    // {
    //   "event": "lead.created",
    //   "data": {
    //     "id": 123,
    //     "name": "João Silva",
    //     "email": "joao@email.com",
    //     "phone": "11999999999",
    //     "message": "Interessado no produto X",
    //     "source": "website"
    //   }
    // }
    
    const eventType = webhookData.event || webhookData.type;
    const leadData = webhookData.data || webhookData;
    
    console.log(`📋 Processando evento AppMax: ${eventType}`);
    
    // Processar diferentes tipos de eventos
    switch (eventType) {
      case 'lead.created':
      case 'lead.updated':
      case 'contact.created':
      case 'contact.updated':
        await processAppmaxLead(leadData);
        break;
      
      case 'deal.created':
      case 'deal.updated':
        await processAppmaxDeal(leadData);
        break;
      
      // Eventos de pedidos pagos
      case 'OrderPaid':
      case 'OrderPaidByPix':
      case 'OrderPaidByBillet':
        await processAppmaxOrder(leadData);
        break;
      
      default:
        console.log(`⚠️ Evento AppMax não reconhecido: ${eventType}`);
        // Para eventos não reconhecidos, tentar processar como pedido se tiver customer
        if (leadData.customer) {
          await processAppmaxOrder(leadData);
        } else {
          await processAppmaxLead(leadData);
        }
    }
    
    res.json({ 
      success: true, 
      message: 'Webhook AppMax processado com sucesso',
      event: eventType,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erro ao processar webhook AppMax:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erro interno do servidor: ' + error.message 
    });
  }
});

// Função para processar leads da AppMax
async function processAppmaxLead(leadData) {
  try {
    console.log('👤 Processando lead da AppMax:', leadData);
    
    // Extrair dados do lead
    const name = leadData.name || leadData.nome || 'Lead AppMax';
    const email = leadData.email || '';
    const phone = leadData.phone || leadData.telefone || leadData.whatsapp || '';
    const message = leadData.message || leadData.mensagem || leadData.observacoes || '';
    const company = leadData.company || leadData.empresa || '';
    const source = 'appmax';
    
    // Formatar número de telefone
    let formattedPhone = phone.replace(/\D/g, ''); // Remove caracteres não numéricos
    
    if (formattedPhone.length === 10) {
      // Adicionar 9 para celulares antigos (ex: 11988887777 -> 11988887777)
      formattedPhone = formattedPhone.substring(0, 2) + '9' + formattedPhone.substring(2);
    }
    
    if (formattedPhone.length === 11 && !formattedPhone.startsWith('55')) {
      formattedPhone = '55' + formattedPhone; // Adicionar código do país
    }
    
    console.log(`📱 Número formatado: ${phone} -> ${formattedPhone}`);
    
    // Salvar/atualizar cliente no CRM
    if (formattedPhone) {
      try {
        const clientData = {
          phoneNumber: formattedPhone,
          name: name,
          email: email,
          company: company,
          source: source,
          status: 'novo',
          priority: 'medium',
          lastContact: new Date(),
          updatedAt: new Date()
        };
        
        // Adicionar nota com dados da AppMax
        if (message) {
          clientData.notes = [{
            text: `📨 Lead da AppMax: ${message}`,
            createdBy: 'AppMax Integration',
            createdAt: new Date()
          }];
        }
        
        const client = await ClientModel.findOneAndUpdate(
          { phoneNumber: formattedPhone },
          { $set: clientData, $push: clientData.notes ? { notes: { $each: clientData.notes } } : {} },
          { new: true, upsert: true }
        );
        
        console.log(`✅ Cliente AppMax salvo/atualizado: ${name} (${formattedPhone})`);
        
        // Emitir evento para atualizar interface em tempo real
        io.emit('client-status-updated', {
          phoneNumber: formattedPhone,
          newStatus: 'novo',
          reason: 'lead_appmax',
          timestamp: new Date().toISOString(),
          source: 'appmax'
        });
        
        // Enviar mensagem de boas-vindas se configurado
        if (isReady && whatsappClient && message) {
          try {
            const welcomeMessage = `🎉 Olá ${name}!\n\nRecebemos seu contato através da AppMax.\n\n📝 Sua mensagem: "${message}"\n\nEm breve nossa equipe entrará em contato!`;
            
            await whatsappClient.sendMessage(`${formattedPhone}@c.us`, welcomeMessage);
            console.log(`📤 Mensagem de boas-vindas enviada para ${name}`);
            
            // Salvar mensagem no banco
            const messageDoc = new Message({
              phoneNumber: formattedPhone,
              messageId: `appmax-welcome-${Date.now()}`,
              body: welcomeMessage,
              type: 'text',
              isFromMe: true,
              timestamp: new Date(),
              chatId: `${formattedPhone}@c.us`,
              fromN8n: false,
              n8nSource: 'appmax'
            });
            
            await messageDoc.save();
            
            // Enviar webhook para n8n quando mensagem de boas-vindas AppMax for enviada
            try {
              const sentMessageData = {
                phoneNumber: formattedPhone,
                message: welcomeMessage,
                author: formattedPhone,
                from: `${formattedPhone}@c.us`,
                to: 'self',
                timestamp: new Date().toISOString(),
                messageId: messageDoc._id?.toString() || 'appmax-welcome-' + Date.now(),
                fromMe: true,
                origem: 'sistema'
              };
              
              await sendSentMessageToN8n(sentMessageData);
              console.log(`🎯 Webhook AppMax boas-vindas enviado para n8n: ${formattedPhone}`);
            } catch (webhookError) {
              console.error('❌ Erro ao enviar webhook AppMax para n8n (não crítico):', webhookError.message);
            }
            
          } catch (whatsappError) {
            console.error('❌ Erro ao enviar mensagem de boas-vindas:', whatsappError.message);
          }
        }
        
      } catch (dbError) {
        console.error('❌ Erro ao salvar cliente AppMax:', dbError);
      }
    } else {
      console.log('⚠️ Número de telefone não fornecido ou inválido no lead da AppMax');
    }
    
  } catch (error) {
    console.error('❌ Erro ao processar lead AppMax:', error);
  }
}

// Função para processar pedidos pagos da AppMax
async function processAppmaxOrder(orderData) {
  try {
    console.log('🛒 Processando pedido pago da AppMax:', {
      id: orderData.id,
      total: orderData.total,
      status: orderData.status,
      customer: orderData.customer?.fullname
    });
    
    // Extrair dados do cliente
    const customer = orderData.customer;
    if (!customer) {
      console.log('⚠️ Pedido AppMax sem dados do cliente');
      return;
    }
    
    const name = customer.fullname || `${customer.firstname} ${customer.lastname}`.trim() || 'Cliente AppMax';
    const email = customer.email || '';
    const phone = customer.telephone || '';
    const total = parseFloat(orderData.total) || 0;
    const orderId = orderData.id;
    const paymentType = orderData.payment_type || 'Desconhecido';
    const status = orderData.status || 'pendente';
    
    // Formatar número de telefone
    let formattedPhone = phone.replace(/\D/g, ''); // Remove caracteres não numéricos
    
    if (formattedPhone.length === 10) {
      // Adicionar 9 para celulares antigos (ex: 11988887777 -> 11988887777)
      formattedPhone = formattedPhone.substring(0, 2) + '9' + formattedPhone.substring(2);
    }
    
    if (formattedPhone.length === 11 && !formattedPhone.startsWith('55')) {
      formattedPhone = '55' + formattedPhone; // Adicionar código do país
    }
    
    console.log(`📱 Número formatado: ${phone} -> ${formattedPhone}`);
    
    // Extrair informações dos produtos
    let productInfo = '';
    if (orderData.bundles && orderData.bundles.length > 0) {
      productInfo = orderData.bundles.map(bundle => 
        `${bundle.name} (${bundle.products?.length || 0} produtos)`
      ).join(', ');
    } else if (orderData.products && orderData.products.length > 0) {
      productInfo = orderData.products.map(product => 
        `${product.name} (Qtd: ${product.quantity})`
      ).join(', ');
    }
    
    // Salvar/atualizar cliente no CRM
    if (formattedPhone) {
      try {
        const clientData = {
          phoneNumber: formattedPhone,
          name: name,
          email: email,
          source: 'appmax',
          status: 'aprovado', // Pedidos pagos sempre têm status aprovado
          priority: 'high', // Pedidos pagos têm alta prioridade
          lastContact: new Date(),
          dealValue: total,
          dealStage: 'closed-won', // Pedido pago = negócio fechado
          updatedAt: new Date()
        };
        
        // Criar nota detalhada do pedido
        const orderNote = {
          text: `🛒 Pedido AppMax #${orderId} - ${paymentType}\n💰 Valor: R$ ${total.toFixed(2)}\n📦 Produtos: ${productInfo}\n✅ Status: ${status}`,
          createdBy: 'AppMax Integration',
          createdAt: new Date()
        };
        
        const client = await ClientModel.findOneAndUpdate(
          { phoneNumber: formattedPhone },
          { 
            $set: clientData,
            $push: { notes: orderNote }
          },
          { new: true, upsert: true }
        );
        
        console.log(`✅ Cliente AppMax salvo/atualizado: ${name} (${formattedPhone}) - Pedido #${orderId}`);
        
        // Emitir evento para atualizar interface em tempo real
        io.emit('client-status-updated', {
          phoneNumber: formattedPhone,
          newStatus: 'aprovado',
          reason: 'pedido_pago_appmax',
          timestamp: new Date().toISOString(),
          source: 'appmax',
          dealValue: total,
          orderId: orderId
        });
        
        // Enviar mensagem de confirmação se WhatsApp estiver conectado
        if (isReady && whatsappClient) {
          try {
            const confirmationMessage = `🎉 Olá ${name}!\n\n✅ Seu pedido #${orderId} foi confirmado!\n💰 Valor: R$ ${total.toFixed(2)}\n💳 Pagamento: ${paymentType}\n\n📦 Em breve você receberá as informações de entrega.\n\nObrigado pela sua compra! 🙏`;
            
            await whatsappClient.sendMessage(`${formattedPhone}@c.us`, confirmationMessage);
            console.log(`📤 Mensagem de confirmação enviada para ${name}`);
            
            // Salvar mensagem no banco
            const messageDoc = new Message({
              phoneNumber: formattedPhone,
              messageId: `appmax-order-${orderId}-${Date.now()}`,
              body: confirmationMessage,
              type: 'text',
              isFromMe: true,
              timestamp: new Date(),
              chatId: `${formattedPhone}@c.us`,
              fromN8n: false,
              n8nSource: 'appmax'
            });
            
            await messageDoc.save();
            
            // Enviar webhook para n8n quando mensagem de confirmação AppMax for enviada
            try {
              const sentMessageData = {
                phoneNumber: formattedPhone,
                message: confirmationMessage,
                author: formattedPhone,
                from: `${formattedPhone}@c.us`,
                to: 'self',
                timestamp: new Date().toISOString(),
                messageId: messageDoc._id?.toString() || 'appmax-order-' + orderId + '-' + Date.now(),
                fromMe: true,
                origem: 'sistema'
              };
              
              await sendSentMessageToN8n(sentMessageData);
              console.log(`🎯 Webhook AppMax confirmação enviado para n8n: ${formattedPhone}`);
            } catch (webhookError) {
              console.error('❌ Erro ao enviar webhook AppMax confirmação para n8n (não crítico):', webhookError.message);
            }
            
          } catch (whatsappError) {
            console.error('❌ Erro ao enviar mensagem de confirmação:', whatsappError.message);
          }
        }
        
      } catch (dbError) {
        console.error('❌ Erro ao salvar pedido AppMax:', dbError);
      }
    } else {
      console.log('⚠️ Número de telefone não fornecido ou inválido no pedido da AppMax');
    }
    
  } catch (error) {
    console.error('❌ Erro ao processar pedido AppMax:', error);
  }
}

// Função para processar deals da AppMax
async function processAppmaxDeal(dealData) {
  try {
    console.log('💰 Processando deal da AppMax:', dealData);
    
    // Extrair dados do deal
    const clientPhone = dealData.client_phone || dealData.telefone_cliente || '';
    const dealValue = dealData.value || dealData.valor || 0;
    const dealStage = dealData.stage || dealData.estagio || 'prospecting';
    const dealStatus = dealData.status || '';
    const dealName = dealData.name || dealData.nome || 'Deal AppMax';
    const lostReason = dealData.lost_reason || dealData.motivo_perda || '';
    const clientName = dealData.client_name || dealData.nome_cliente || 'Cliente';
    
    if (clientPhone) {
      let formattedPhone = clientPhone.replace(/\D/g, '');
      
      if (formattedPhone.length === 10) {
        formattedPhone = formattedPhone.substring(0, 2) + '9' + formattedPhone.substring(2);
      }
      
      if (formattedPhone.length === 11 && !formattedPhone.startsWith('55')) {
        formattedPhone = '55' + formattedPhone;
      }
      
      try {
        // Determinar o status do cliente baseado no deal
        let clientStatus = 'andamento'; // padrão
        
        if (dealStage === 'lost' || dealStatus === 'reprovado' || dealStatus === 'cancelled') {
          clientStatus = 'reprovado';
        } else if (dealStage === 'won' || dealStage === 'closed-won' || dealStatus === 'aprovado') {
          clientStatus = 'aprovado';
        }
        
        // Atualizar dados do deal no cliente
        const updateData = {
          dealValue: dealValue,
          dealStage: dealStage,
          status: clientStatus, // IMPORTANTE: atualizar o status do cliente
          lastContact: new Date(),
          updatedAt: new Date()
        };
        
        // Adicionar nota sobre o deal
        let noteText = `💰 Deal AppMax atualizado: ${dealName} - R$ ${dealValue.toFixed(2)} (${dealStage})`;
        if (lostReason && clientStatus === 'reprovado') {
          noteText += `\n❌ Motivo da reprovação: ${lostReason}`;
        }
        
        const dealNote = {
          text: noteText,
          createdBy: 'AppMax Integration',
          createdAt: new Date()
        };
        
        const client = await ClientModel.findOneAndUpdate(
          { phoneNumber: formattedPhone },
          { 
            $set: updateData,
            $push: { notes: dealNote }
          },
          { new: true, upsert: true }
        );
        
        if (client) {
          console.log(`✅ Deal AppMax atualizado para cliente: ${formattedPhone} - Status: ${clientStatus}`);
          
          // Emitir evento para atualizar interface em tempo real
          const eventData = {
            phoneNumber: formattedPhone,
            newStatus: clientStatus,
            reason: lostReason || 'deal_atualizado_appmax',
            timestamp: new Date().toISOString(),
            dealValue: dealValue,
            dealStage: dealStage,
            source: 'appmax'
          };
          console.log('🔥 EMITINDO EVENTO client-status-updated (AppMax Deal):', JSON.stringify(eventData, null, 2));
          console.log('🔥 Total de clientes conectados:', io.engine.clientsCount);
          io.emit('client-status-updated', eventData);
          
          // Enviar mensagem para deals reprovados se WhatsApp estiver conectado
          if (clientStatus === 'reprovado' && isReady && whatsappClient) {
            try {
              let reprovationMessage = `❌ Olá ${clientName}!\n\nInfelizmente sua proposta "${dealName}" não foi aprovada.`;
              
              if (lostReason) {
                reprovationMessage += `\n\n📝 Motivo: ${lostReason}`;
              }
              
              reprovationMessage += `\n\n💡 Nossa equipe está sempre disponível para esclarecer dúvidas ou apresentar novas propostas.\n\nObrigado pelo seu interesse! 🙏`;
              
              await whatsappClient.sendMessage(`${formattedPhone}@c.us`, reprovationMessage);
              console.log(`📤 Mensagem de reprovação enviada para ${clientName} (${formattedPhone})`);
              
              // Salvar mensagem no banco
              const messageDoc = new Message({
                phoneNumber: formattedPhone,
                messageId: `appmax-rejection-${dealData.id}-${Date.now()}`,
                body: reprovationMessage,
                type: 'text',
                isFromMe: true,
                timestamp: new Date(),
                chatId: `${formattedPhone}@c.us`,
                fromN8n: false,
                n8nSource: 'appmax'
              });
              
              await messageDoc.save();
              
              // Enviar webhook para n8n quando mensagem de reprovação AppMax for enviada
              try {
                const sentMessageData = {
                  phoneNumber: formattedPhone,
                  message: reprovationMessage,
                  author: formattedPhone,
                  from: `${formattedPhone}@c.us`,
                  to: 'self',
                  timestamp: new Date().toISOString(),
                  messageId: messageDoc._id?.toString() || 'appmax-rejection-' + dealData.id + '-' + Date.now(),
                  fromMe: true,
                  origem: 'sistema'
                };
                
                await sendSentMessageToN8n(sentMessageData);
                console.log(`🎯 Webhook AppMax reprovação enviado para n8n: ${formattedPhone}`);
              } catch (webhookError) {
                console.error('❌ Erro ao enviar webhook AppMax reprovação para n8n (não crítico):', webhookError.message);
              }
              
            } catch (whatsappError) {
              console.error('❌ Erro ao enviar mensagem de reprovação:', whatsappError.message);
            }
          }
          
        } else {
          console.log(`⚠️ Cliente não encontrado para deal AppMax: ${formattedPhone}`);
        }
        
      } catch (dbError) {
        console.error('❌ Erro ao atualizar deal AppMax:', dbError);
      }
    }
    
  } catch (error) {
    console.error('❌ Erro ao processar deal AppMax:', error);
  }
}

// Endpoint para testar webhook da AppMax
app.get('/webhook/appmax/test', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook AppMax endpoint funcionando',
    timestamp: new Date().toISOString(),
    webhookUrl: `${req.protocol}://${req.get('host')}/webhook/appmax/receive`,
    expectedFormat: {
      method: 'POST',
      url: '/webhook/appmax/receive',
      headers: {
        'Content-Type': 'application/json',
        'X-AppMax-Signature': 'seu_secret_aqui (opcional)'
      },
      body: {
        event: 'lead.created',
        data: {
          id: 123,
          name: 'João Silva',
          email: 'joao@email.com',
          phone: '11999999999',
          message: 'Interessado no produto X',
          company: 'Empresa ABC',
          source: 'website'
        }
      }
    },
    examples: {
      leadCreated: {
        event: 'lead.created',
        data: {
          name: 'Maria Santos',
          email: 'maria@email.com',
          phone: '11988887777',
          message: 'Gostaria de mais informações sobre seus serviços',
          company: 'Tech Solutions'
        }
      },
      dealUpdated: {
        event: 'deal.updated',
        data: {
          name: 'Proposta Empresa XYZ',
          client_phone: '11999999999',
          value: 5000,
          stage: 'negotiation'
        }
      }
    }
  });
});

// Função para enviar mensagem enviada (fromMe = true) para n8n
async function sendSentMessageToN8n(messageData) {
  try {
    // Verificar se disparo em massa está ativo
    if (massDispatchActive.isActive) {
      console.log('🚫 Disparo em massa ativo, webhook de mensagem enviada bloqueado');
      return;
    }
    
    // Verificar se temos URL configurada para mensagens enviadas
    if (!integrationsConfig.n8nSentUrl) {
      console.log('🚫 URL de webhook para mensagens enviadas não configurada');
      return;
    }
    
    console.log(`📤 Enviando APENAS FLAG FromMe para n8n: ${messageData.phoneNumber}`);
    
    const axios = require('axios');
    
    // PAYLOAD SIMPLIFICADO - APENAS A FLAG FromMe, AUTHOR E TO CONFORME SOLICITADO
    const payload = {
      FromMe: true,
      author: myWhatsAppNumber || messageData.author,
      to: messageData.phoneNumber + '@c.us',
      phoneNumber: messageData.phoneNumber
    };
    
    console.log('📦 Payload SIMPLIFICADO enviado para n8n:', JSON.stringify(payload, null, 2));
    
    const response = await axios.post(integrationsConfig.n8nSentUrl, payload, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Clerky-CRM-Integration-Sent'
      }
    });
    
    console.log(`✅ Flag FromMe enviada para n8n com sucesso: ${response.status}`);
    
  } catch (error) {
    console.error('❌ Erro ao enviar flag FromMe para n8n:', error.message);
    
    // Log mais detalhado do erro
    if (error.response) {
      console.error('📄 Resposta do erro (FromMe):', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    }
  }
}

// Função centralizada para envio de webhooks n8n
async function sendCentralizedWebhook(type, data) {
  try {
    // Verificar se disparo em massa está ativo
    if (massDispatchActive.isActive) {
      console.log('🚫 Disparo em massa ativo, webhook bloqueado');
      return;
    }
    
    if (!integrationsConfig.iaEnabled) {
      console.log('🤖 IA desabilitada, não enviando webhook');
      return;
    }
    
    // Determinar qual URL usar baseado na configuração useTestUrl
    let webhookUrl;
    if (integrationsConfig.useTestUrl) {
      webhookUrl = integrationsConfig.n8nTestUrl;
      if (webhookUrl) {
        console.log('🧪 Usando URL de teste (configurado para teste)');
      } else {
        webhookUrl = integrationsConfig.n8nProdUrl;
        console.log('🚀 Fallback para URL de produção (teste não configurado)');
      }
    } else {
      webhookUrl = integrationsConfig.n8nProdUrl;
      if (webhookUrl) {
        console.log('🚀 Usando URL de produção (configurado para produção)');
      } else {
        webhookUrl = integrationsConfig.n8nTestUrl;
        console.log('🧪 Fallback para URL de teste (produção não configurado)');
      }
    }
    
    if (!webhookUrl) {
      console.log('❌ Nenhuma URL n8n configurada');
      return;
    }
    
    let payload;
    
    switch (type) {
      case 'message_received':
        // Payload completo para mensagens recebidas
        payload = {
          phoneNumber: data.phoneNumber,
          name: data.name,
          body: data.body,
          type: data.type,
          timestamp: data.timestamp,
          chatId: data.chatId,
          FromMe: false,
          to: data.to,
          'mensagem-audio': data.audioData || null
        };
        break;
        
      case 'message_sent_mobile':
        // Payload simples para mensagens enviadas pelo celular
        payload = {
          FromMe: true,
          author: data.author,
          to: data.to,
          phoneNumber: data.to.replace('@c.us', '')
        };
        break;
        
      case 'message_sent_chat':
        // Payload simples para mensagens enviadas pela página de chat
        payload = {
          FromMe: true,
          author: data.author,
          to: data.to,
          phoneNumber: data.to.replace('@c.us', '')
        };
        break;
        
      default:
        console.log(`❌ Tipo de webhook não reconhecido: ${type}`);
        return;
    }
    
    console.log(`📦 Payload ${type} enviado para n8n:`, JSON.stringify(payload, null, 2));
    
    const axios = require('axios');
    const response = await axios.post(webhookUrl, payload, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Clerky-WhatsApp-Integration/1.0'
      }
    });
    
    console.log(`✅ Webhook ${type} enviado para n8n com sucesso: ${response.status}`);
    
  } catch (error) {
    console.error(`❌ Erro ao enviar webhook ${type} para n8n:`, error.message);
  }
}

// Função para enviar mensagem para n8n (chamada quando mensagem é recebida)
async function sendToN8n(messageData) {
  try {
    // Verificar se disparo em massa está ativo
    if (massDispatchActive.isActive) {
      console.log('🚫 Disparo em massa ativo, webhook sendToN8n bloqueado');
      return;
    }
    
    if (!integrationsConfig.iaEnabled) {
      console.log('🤖 IA desabilitada, não enviando para n8n');
      return;
    }
    

    
    // Se for disparo em massa e bypass estiver ativo, não enviar
    if (messageData.isMassDispatch && integrationsConfig.massDispatchBypass) {
      console.log('🚫 Disparo em massa detectado, pulando n8n (bypass ativo)');
      return;
    }
    
    // Determinar qual URL usar baseado na configuração useTestUrl
    let webhookUrl;
    if (integrationsConfig.useTestUrl) {
      // Usar URL de teste se configurado para teste
      webhookUrl = integrationsConfig.n8nTestUrl;
      if (webhookUrl) {
        console.log('🧪 Usando URL de teste (configurado para teste)');
      } else {
        // Fallback para produção se teste não estiver configurado
        webhookUrl = integrationsConfig.n8nProdUrl;
        console.log('🚀 Fallback para URL de produção (teste não configurado)');
      }
    } else {
      // Usar URL de produção por padrão
      webhookUrl = integrationsConfig.n8nProdUrl;
      if (webhookUrl) {
        console.log('🚀 Usando URL de produção (configurado para produção)');
      } else {
        // Fallback para teste se produção não estiver configurado
        webhookUrl = integrationsConfig.n8nTestUrl;
        console.log('🧪 Fallback para URL de teste (produção não configurado)');
      }
    }
    
    if (!webhookUrl) {
      console.log('❌ Nenhuma URL n8n configurada');
      return;
    }
    
    console.log(`🤖 Enviando mensagem para n8n: ${messageData.phoneNumber}`);
    
    const axios = require('axios');
    
    // Montar payload
    const isAudio = (messageData.mediaType === 'audio' || messageData.mediaType === 'ptt');
    const fromMe = messageData.fromMe !== undefined ? messageData.fromMe : false;
    const payload = {
      from: messageData.from || messageData.phoneNumber,
      body: isAudio ? null : messageData.message,
      timestamp: messageData.timestamp || new Date().toISOString(),
      type: messageData.mediaType || 'text',
      id: messageData.messageId,
      to: messageData.to || 'self',
      author: messageData.author || messageData.phoneNumber,
      deviceType: messageData.deviceType || 'web',
      isForwarded: messageData.isForwarded || false,
      isStatus: messageData.isStatus || false,
      isStarred: messageData.isStarred || false,
      isGroupMsg: messageData.isGroup || false,
      chatId: messageData.chatId,
      nomeContato: messageData.contactName || 'Desconhecido',
      fromMe: fromMe,
      origem: messageData.origem || (fromMe ? 'enviada' : 'recebida'),
      webhookReceiveUrl: `${process.env.BASE_URL || 'http://localhost:3001'}/webhook/n8n/receive`
    };
    
    // Se for mensagem de áudio, baixar e converter para base64
    if (isAudio && messageData.originalMessage) {
      try {
        const media = await messageData.originalMessage.downloadMedia();
        if (media && media.data) {
          payload['mensagem-audio'] = media.data;
        }
      } catch (audioError) {
        console.log('⚠️ Erro ao baixar áudio para n8n:', audioError.message);
      }
    }
    
    // Log amigável
    const logPayload = { ...payload };
    if (isAudio && logPayload['mensagem-audio']) {
      logPayload['mensagem-audio'] = true;
    }
    console.log('📦 Payload enviado para n8n:', JSON.stringify(logPayload, null, 2));
    
    const response = await axios.post(webhookUrl, payload, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Clerky-CRM-Integration'
      }
    });
    
    console.log(`✅ Mensagem enviada para n8n com sucesso: ${response.status}`);
    
  } catch (error) {
    console.error('❌ Erro ao enviar para n8n:', error.message);
    
    // Log mais detalhado do erro
    if (error.response) {
      console.error('📄 Resposta do erro:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      });
    }
  }
}

// Sistema de captura de logs do console
let systemLogs = [];
const MAX_LOGS = 50;

// Função para adicionar log ao sistema
function addSystemLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('pt-BR');
  const logEntry = { timestamp, message, type };
  
  systemLogs.push(logEntry);
  
  // Manter apenas os últimos MAX_LOGS
  if (systemLogs.length > MAX_LOGS) {
    systemLogs = systemLogs.slice(-MAX_LOGS);
  }
  
  // Emitir para todos os clientes conectados
  io.emit('system-log', logEntry);
}

// Interceptar console.log para capturar logs
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = function(...args) {
  const message = args.join(' ');
  addSystemLog(message, 'info');
  originalConsoleLog.apply(console, args);
};

console.error = function(...args) {
  const message = args.join(' ');
  addSystemLog(message, 'error');
  originalConsoleError.apply(console, args);
};

console.warn = function(...args) {
  const message = args.join(' ');
  addSystemLog(message, 'warn');
  originalConsoleWarn.apply(console, args);
};

// Socket.IO
io.on('connection', (socket) => {
  console.log('👤 Cliente conectado via Socket.IO');
  
  // Enviar logs existentes para o cliente que acabou de conectar
  socket.emit('system-logs-history', systemLogs);
  
  socket.on('disconnect', () => {
    console.log('👋 Cliente desconectado');
  });
});

// HTML Templates
function getDashboardHTML() {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Dashboard - Clerky CRM</title>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            ${getStandardHeaderCSS()}
            ${getStandardFooterCSS()}
            
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: white;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
            }
            
            .dashboard-container {
                flex: 1;
                max-width: 1400px;
                margin: 0 auto;
                padding: 20px;
            }
            

            
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 40px;
            }
            
            .stat-card {
                background: rgba(255,255,255,0.9);
                border-radius: 16px;
                padding: 25px;
                text-align: center;
                box-shadow: 0 10px 25px rgba(0,0,0,0.08);
                border: 1px solid rgba(255,255,255,0.2);
                transition: all 0.3s ease;
                position: relative;
                overflow: hidden;
            }
            
            .stat-card::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 4px;
                background: linear-gradient(90deg, #25D366, #128C7E);
            }
            
            .stat-card:hover {
                transform: translateY(-5px);
                box-shadow: 0 20px 40px rgba(0,0,0,0.15);
            }
            
            .stat-icon {
                font-size: 2.5rem;
                margin-bottom: 15px;
            }
            
            .stat-number {
                font-size: 2rem;
                font-weight: 700;
                color: #1e293b;
                margin-bottom: 5px;
            }
            
            .stat-label {
                color: #64748b;
                font-size: 0.9rem;
                font-weight: 500;
            }
            
            .content-grid {
                display: grid;
                grid-template-columns: 2fr 1fr;
                gap: 30px;
                margin-bottom: 40px;
            }
            
            .offers-section, .updates-section {
                background: linear-gradient(135deg, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.95) 100%);
                border-radius: 24px;
                padding: 35px;
                box-shadow: 0 20px 40px rgba(0,0,0,0.08);
                backdrop-filter: blur(20px);
                border: 1px solid rgba(255,255,255,0.3);
                position: relative;
                overflow: hidden;
            }
            
            .offers-section::before {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                right: 0;
                height: 4px;
                background: linear-gradient(90deg, #25D366, #128C7E, #25D366);
                background-size: 200% 100%;
                animation: shimmer 3s ease-in-out infinite;
            }
            
            @keyframes shimmer {
                0%, 100% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
            }
            
            .section-title {
                font-size: 2rem;
                font-weight: 800;
                background: linear-gradient(135deg, #1e293b 0%, #475569 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
                margin-bottom: 30px;
                display: flex;
                align-items: center;
                gap: 15px;
                position: relative;
            }
            
            .section-title::after {
                content: '';
                position: absolute;
                bottom: -8px;
                left: 0;
                width: 60px;
                height: 3px;
                background: linear-gradient(90deg, #25D366, #128C7E);
                border-radius: 2px;
            }
            
            .offer-card {
                background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
                border-radius: 20px;
                padding: 30px;
                color: white;
                margin-bottom: 25px;
                position: relative;
                overflow: hidden;
                cursor: pointer;
                transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                box-shadow: 0 10px 30px rgba(37, 211, 102, 0.2);
                border: 1px solid rgba(255, 255, 255, 0.1);
            }
            
            .offer-card::before {
                content: '';
                position: absolute;
                top: -50%;
                right: -50%;
                width: 200%;
                height: 200%;
                background: radial-gradient(circle, rgba(255,255,255,0.15) 0%, transparent 70%);
                transform: scale(0) rotate(0deg);
                transition: all 0.6s cubic-bezier(0.4, 0, 0.2, 1);
            }
            
            .offer-card:hover::before {
                transform: scale(1) rotate(180deg);
            }
            
            .offer-card:hover {
                transform: translateY(-8px) scale(1.02);
                box-shadow: 0 25px 50px rgba(37, 211, 102, 0.4);
            }
            
            .offer-card:nth-child(2) {
                background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
                box-shadow: 0 10px 30px rgba(245, 158, 11, 0.2);
            }
            
            .offer-card:nth-child(2):hover {
                box-shadow: 0 25px 50px rgba(245, 158, 11, 0.4);
            }
            
            .offer-card:nth-child(3) {
                background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                box-shadow: 0 10px 30px rgba(139, 92, 246, 0.2);
            }
            
            .offer-card:nth-child(3):hover {
                box-shadow: 0 25px 50px rgba(139, 92, 246, 0.4);
            }
            
            .offer-badge {
                background: rgba(255,255,255,0.25);
                padding: 8px 16px;
                border-radius: 25px;
                font-size: 0.85rem;
                font-weight: 700;
                margin-bottom: 20px;
                display: inline-block;
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.2);
                text-shadow: 0 1px 2px rgba(0,0,0,0.1);
                animation: badge-pulse 2s ease-in-out infinite;
            }
            
            @keyframes badge-pulse {
                0%, 100% { transform: scale(1); }
                50% { transform: scale(1.05); }
            }
            
            .offer-title {
                font-size: 1.5rem;
                font-weight: 800;
                margin-bottom: 15px;
                text-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            
            .offer-description {
                opacity: 0.95;
                margin-bottom: 20px;
                line-height: 1.6;
                font-size: 1rem;
                text-shadow: 0 1px 2px rgba(0,0,0,0.1);
            }
            
            .offer-price {
                font-size: 1.8rem;
                font-weight: 900;
                margin-bottom: 20px;
                text-shadow: 0 2px 4px rgba(0,0,0,0.1);
                display: flex;
                align-items: center;
                gap: 10px;
            }
            
            .offer-price .original-price {
                font-size: 1.2rem;
                opacity: 0.7;
                text-decoration: line-through;
                font-weight: 600;
            }
            
            .offer-btn {
                background: rgba(255,255,255,0.25);
                border: 2px solid rgba(255,255,255,0.3);
                color: white;
                padding: 12px 24px;
                border-radius: 15px;
                font-weight: 700;
                font-size: 1rem;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                text-decoration: none;
                display: inline-flex;
                align-items: center;
                gap: 8px;
                backdrop-filter: blur(10px);
                text-shadow: 0 1px 2px rgba(0,0,0,0.1);
            }
            
            .offer-btn:hover {
                background: rgba(255,255,255,0.35);
                border-color: rgba(255,255,255,0.5);
                transform: translateY(-3px);
                box-shadow: 0 8px 20px rgba(0,0,0,0.2);
                color: white;
                text-decoration: none;
            }
            
            .update-item {
                padding: 20px;
                border-radius: 12px;
                border-left: 4px solid #25D366;
                background: rgba(37,211,102,0.05);
                margin-bottom: 15px;
                transition: all 0.3s ease;
            }
            
            .update-item:hover {
                background: rgba(37,211,102,0.1);
                transform: translateX(5px);
            }
            
            .update-date {
                font-size: 0.8rem;
                color: #25D366;
                font-weight: 600;
                margin-bottom: 8px;
            }
            
            .update-title {
                font-weight: 700;
                color: #1e293b;
                margin-bottom: 8px;
            }
            
            .update-description {
                color: #64748b;
                font-size: 0.9rem;
                line-height: 1.5;
            }
            
            .quick-actions {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                gap: 20px;
                margin-bottom: 40px;
            }
            
            .action-card {
                background: rgba(255,255,255,0.95);
                border-radius: 16px;
                padding: 25px;
                text-align: center;
                box-shadow: 0 10px 25px rgba(0,0,0,0.08);
                border: 1px solid rgba(255,255,255,0.2);
                transition: all 0.3s ease;
                cursor: pointer;
                text-decoration: none;
                color: inherit;
            }
            
            .action-card:hover {
                transform: translateY(-5px);
                box-shadow: 0 20px 40px rgba(0,0,0,0.15);
                color: inherit;
                text-decoration: none;
            }
            
            .action-icon {
                font-size: 3rem;
                margin-bottom: 15px;
                background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
            }
            
            .action-title {
                font-size: 1.2rem;
                font-weight: 700;
                color: #1e293b;
                margin-bottom: 8px;
            }
            
            .action-description {
                color: #64748b;
                font-size: 0.9rem;
            }
            
            .testimonial-section {
                background: rgba(255,255,255,0.95);
                border-radius: 20px;
                padding: 40px;
                margin-bottom: 40px;
                box-shadow: 0 15px 30px rgba(0,0,0,0.1);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255,255,255,0.2);
                text-align: center;
            }
            
            .testimonial-quote {
                font-size: 1.3rem;
                font-style: italic;
                color: #1e293b;
                margin-bottom: 20px;
                line-height: 1.6;
            }
            
            .testimonial-author {
                font-weight: 600;
                color: #25D366;
            }
            
            @media (max-width: 768px) {
                .content-grid {
                    grid-template-columns: 1fr;
                    gap: 20px;
                }
                
                .dashboard-container {
                    padding: 15px;
                }
                
                .stats-grid {
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                }
                
                .offers-section, .updates-section {
                    padding: 25px;
                    border-radius: 20px;
                }
                
                .section-title {
                    font-size: 1.6rem;
                    margin-bottom: 25px;
                }
                
                .offer-card {
                    padding: 25px;
                    margin-bottom: 20px;
                }
                
                .offer-title {
                    font-size: 1.3rem;
                }
                
                .offer-price {
                    font-size: 1.5rem;
                }
                
                .offer-btn {
                    padding: 10px 20px;
                    font-size: 0.9rem;
                }
            }
            
            @media (max-width: 480px) {
                .offers-section, .updates-section {
                    padding: 20px;
                    border-radius: 16px;
                }
                
                .section-title {
                    font-size: 1.4rem;
                    margin-bottom: 20px;
                }
                
                .offer-card {
                    padding: 20px;
                    margin-bottom: 15px;
                    border-radius: 16px;
                }
                
                .offer-badge {
                    padding: 6px 12px;
                    font-size: 0.8rem;
                    margin-bottom: 15px;
                }
                
                .offer-title {
                    font-size: 1.2rem;
                    margin-bottom: 12px;
                }
                
                .offer-description {
                    font-size: 0.9rem;
                    margin-bottom: 15px;
                }
                
                .offer-price {
                    font-size: 1.3rem;
                    margin-bottom: 15px;
                }
                
                .offer-price .original-price {
                    font-size: 1rem;
                }
                
                .offer-btn {
                    padding: 10px 16px;
                    font-size: 0.85rem;
                    border-radius: 12px;
                }
                
                .quick-actions {
                    grid-template-columns: 1fr;
                    gap: 15px;
                }
                
                .action-card {
                    padding: 20px;
                }
            }
        </style>
    </head>
    <body>
        ${getStandardHeader('Dashboard', '<i class="fas fa-tachometer-alt"></i>', 'dashboard')}
        
        <div class="dashboard-container">
            <!-- Quick Actions -->
            <div class="quick-actions">
                <a href="/chat" class="action-card">
                    <div class="action-icon">💬</div>
                    <div class="action-title">Chat em Tempo Real</div>
                    <div class="action-description">Converse com seus clientes instantaneamente</div>
                </a>
                <a href="/disparo" class="action-card">
                    <div class="action-icon">📤</div>
                    <div class="action-title">Disparo em Massa</div>
                    <div class="action-description">Envie mensagens para múltiplos contatos</div>
                </a>
                <a href="/whatsapp" class="action-card">
                    <div class="action-icon">⚙️</div>
                    <div class="action-title">Configurações</div>
                    <div class="action-description">Gerencie sua conexão WhatsApp</div>
                </a>
            </div>
            
            <!-- Content Grid -->
            <div class="content-grid">
                <!-- Offers Section -->
                <div class="offers-section">
                    <h2 class="section-title">
                        🎯 Ofertas Exclusivas
                    </h2>
                    
                    <div class="offer-card">
                        <div class="offer-badge">🔥 OFERTA LIMITADA</div>
                        <div class="offer-title">Clerky CRM Pro</div>
                        <div class="offer-description">
                            Desbloqueie recursos avançados: CRM completo, relatórios detalhados, 
                            integrações com APIs, suporte prioritário e muito mais!
                        </div>
                        <div class="offer-price">
                            R$ 67/mês
                            <span class="original-price">R$ 97/mês</span>
                        </div>
                        <a href="#" class="offer-btn">
                            <i class="fas fa-rocket"></i>
                            Fazer Upgrade
                        </a>
                    </div>
                    
                    <div class="offer-card">
                        <div class="offer-badge">⭐ MAIS POPULAR</div>
                        <div class="offer-title">Automação Avançada</div>
                        <div class="offer-description">
                            Chatbots inteligentes, respostas automáticas, agendamento de mensagens 
                            e fluxos de conversação personalizados.
                        </div>
                        <div class="offer-price">
                            R$ 147/mês
                        </div>
                        <a href="#" class="offer-btn">
                            <i class="fas fa-robot"></i>
                            Ativar Automação
                        </a>
                    </div>
                    
                    <div class="offer-card">
                        <div class="offer-badge">💎 PREMIUM</div>
                        <div class="offer-title">Suporte Dedicado</div>
                        <div class="offer-description">
                            Consultoria personalizada, configuração completa, treinamento da equipe 
                            e suporte 24/7 via WhatsApp.
                        </div>
                        <div class="offer-price">
                            R$ 297/mês
                        </div>
                        <a href="#" class="offer-btn">
                            <i class="fas fa-user-tie"></i>
                            Contratar Consultoria
                        </a>
                    </div>
                </div>
                
                <!-- Updates Section -->
                <div class="updates-section">
                    <h2 class="section-title">
                        📢 Últimas Atualizações
                    </h2>
                    
                    <div class="update-item">
                        <div class="update-date">🗓️ 15 Jan 2025</div>
                        <div class="update-title">🎵 Mensagens de Voz Otimizadas</div>
                        <div class="update-description">
                            Implementamos conversão automática para MP3 e otimização de qualidade 
                            para garantir que seus áudios cheguem perfeitos no WhatsApp.
                        </div>
                    </div>
                    
                    <div class="update-item">
                        <div class="update-date">🗓️ 12 Jan 2025</div>
                        <div class="update-title">🔧 Correção Automática de DDD</div>
                        <div class="update-description">
                            Sistema inteligente que corrige automaticamente números de telefone 
                            baseado no DDD, removendo o 9º dígito quando necessário.
                        </div>
                    </div>
                    
                    <div class="update-item">
                        <div class="update-date">🗓️ 10 Jan 2025</div>
                        <div class="update-title">📋 Templates Salvos Melhorados</div>
                        <div class="update-description">
                            Agora você pode salvar templates com arquivos e reutilizá-los 
                            automaticamente sem precisar fazer upload novamente.
                        </div>
                    </div>
                    
                    <div class="update-item">
                        <div class="update-date">🗓️ 08 Jan 2025</div>
                        <div class="update-title">🎨 Interface Unificada</div>
                        <div class="update-description">
                            Novo design com header e footer padronizados em todas as páginas, 
                            criando uma experiência visual consistente e profissional.
                        </div>
                    </div>
                    
                    <div class="update-item">
                        <div class="update-date">🗓️ 05 Jan 2025</div>
                        <div class="update-title">📊 Relatórios Avançados</div>
                        <div class="update-description">
                            Relatórios detalhados com métricas de vendas, top clientes, 
                            pipeline de negócios e análise de performance.
                        </div>
                    </div>
                </div>
            </div>
            

        </div>
        
        ${getStandardFooter()}
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
            // Variável para armazenar tempo de início da aplicação
            let startTime = Date.now();
            
            // Carregar estatísticas reais do servidor
            async function loadRealStats() {
                try {
                    const response = await fetch('/api/dashboard-stats');
                    const data = await response.json();
                    
                    // Atualizar os elementos com os dados reais
                    document.getElementById('mensagens-enviadas').textContent = data.mensagensEnviadas.toLocaleString('pt-BR');
                    document.getElementById('clientes-ativos').textContent = data.clientesAtivos.toLocaleString('pt-BR');
                    document.getElementById('taxa-conversao').textContent = data.taxaConversao + '%';
                    document.getElementById('uptime').textContent = data.uptime + '%';
                    
                } catch (error) {
                    console.error('Erro ao carregar estatísticas:', error);
                    // Fallback para valores padrão em caso de erro
                    document.getElementById('mensagens-enviadas').textContent = '0';
                    document.getElementById('clientes-ativos').textContent = '0';
                    document.getElementById('taxa-conversao').textContent = '0%';
                    document.getElementById('uptime').textContent = '0%';
                }
            }
            
            // Animação de números crescentes
            function animateNumbers() {
                const numbers = document.querySelectorAll('.stat-number');
                
                numbers.forEach(number => {
                    const target = number.textContent;
                    const isPercentage = target.includes('%');
                    const numericValue = parseInt(target.replace(/[^0-9]/g, ''));
                    
                    let current = 0;
                    const increment = numericValue / 50;
                    
                    const timer = setInterval(() => {
                        current += increment;
                        if (current >= numericValue) {
                            current = numericValue;
                            clearInterval(timer);
                        }
                        
                        if (isPercentage) {
                            number.textContent = Math.floor(current) + '%';
                        } else if (target.includes('.')) {
                            number.textContent = Math.floor(current).toLocaleString('pt-BR');
                        } else {
                            number.textContent = Math.floor(current);
                        }
                    }, 50);
                });
            }
            
            // Conectar ao WebSocket para atualizações em tempo real
            const socket = io();
            

            
            // Executar quando a página carregar
            window.addEventListener('load', async () => {
                await loadRealStats();
                animateNumbers();
                
                // Atualizar stats a cada 5 segundos (tempo real)
                setInterval(loadRealStats, 5000);
            });
            
            // Adicionar efeitos de hover dinâmicos
            document.querySelectorAll('.offer-card').forEach(card => {
                card.addEventListener('mouseenter', function() {
                    this.style.transform = 'translateY(-5px) scale(1.02)';
                });
                
                card.addEventListener('mouseleave', function() {
                    this.style.transform = 'translateY(0) scale(1)';
                });
            });
        </script>
    </body>
    </html>
  `;
}

function getLoginHTML() {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Clerky CRM - Login</title>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <style>
            ${getStandardFooterCSS()}
            
            body {
                display: flex;
                flex-direction: column;
                min-height: 100vh;
            }
            
            .login-container {
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 2rem 1rem;
            }
            
            .login-logo {
                height: 60px;
                width: auto;
                max-width: 250px;
                object-fit: contain;
                filter: drop-shadow(0 4px 8px rgba(0,0,0,0.1));
                transition: all 0.3s ease;
            }
            
            .login-logo:hover {
                transform: scale(1.05);
                filter: drop-shadow(0 6px 12px rgba(0,0,0,0.15));
            }
        </style>
    </head>
    <body style="background: white;">
        <div class="login-container">
        <div class="bg-white p-8 rounded-xl shadow-2xl w-full max-w-md">
            <div class="text-center mb-8">
                <img src="/img/clerky-Disparo-login.png" alt="Clerky CRM" class="login-logo mx-auto mb-4" />
                <p class="text-gray-600">Sistema de CRM com WhatsApp</p>
            </div>
            
            <form action="/login" method="POST" class="space-y-6">
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">
                        <i class="fas fa-user mr-2"></i>Usuário
                    </label>
                    <input type="text" name="username" required 
                           class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent">
                </div>
                
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">
                        <i class="fas fa-lock mr-2"></i>Senha
                    </label>
                    <input type="password" name="password" required 
                           class="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent">
                </div>
                
                <button type="submit" 
                        class="w-full bg-green-500 text-white py-3 px-4 rounded-lg hover:bg-green-600 transition duration-200 font-medium">
                    <i class="fas fa-sign-in-alt mr-2"></i>Entrar
                </button>
            </form>
            

        </div>
        </div>
        
        ${getStandardFooter()}
    </body>
    </html>
  `;
}

// Função para gerar header padronizado
function getStandardHeader(pageTitle, pageIcon, currentPage) {
  return `
    <div class="standard-header">
      <div class="header-content">
        <div class="header-left">
          <div class="header-icon">${pageIcon}</div>
          <div class="header-text">
            <img src="/img/clerky-Disparo.png" alt="Clerky CRM" class="header-logo" />
            <p class="header-subtitle">Sistema de CRM com WhatsApp</p>
          </div>
        </div>
        <div class="header-nav">
          <a href="/" class="nav-item ${currentPage === 'dashboard' ? 'active' : ''}">
            <i class="fas fa-tachometer-alt"></i>
            <span>Dashboard</span>
          </a>
          <a href="/chat" class="nav-item ${currentPage === 'chat' ? 'active' : ''}">
            <i class="fas fa-comments"></i>
            <span>Chat</span>
          </a>
          <a href="/disparo" class="nav-item ${currentPage === 'disparo' ? 'active' : ''}">
            <i class="fas fa-paper-plane"></i>
            <span>Disparo</span>
          </a>
          <a href="/whatsapp" class="nav-item ${currentPage === 'whatsapp' ? 'active' : ''}">
            <i class="fas fa-cog"></i>
            <span>Configurações</span>
          </a>
          <a href="/logout" class="nav-item logout">
            <i class="fas fa-sign-out-alt"></i>
            <span>Sair</span>
          </a>
        </div>
      </div>
    </div>
  `;
}

// Função para gerar footer padronizado
function getStandardFooter() {
  return `
    <footer class="standard-footer">
      <div class="footer-content">
        <!-- Seção Principal -->
        <div class="footer-main">
          <div class="footer-brand">
            <div class="footer-logo">
              <i class="fab fa-whatsapp"></i>
              <span>Clerky CRM</span>
            </div>
            <p class="footer-description">
              Sistema completo de CRM integrado com WhatsApp para gestão de relacionamento com clientes.
            </p>
          </div>
          
          <div class="footer-links">
            <div class="link-column">
              <h4>📞 Suporte</h4>
              <ul>
                <li><a href="mailto:suporte@clerky.com">📧 Email Suporte</a></li>
                <li><a href="tel:+5511999999999">📱 WhatsApp Suporte</a></li>
                <li><a href="#">📖 Documentação</a></li>
                <li><a href="#">❓ FAQ</a></li>
                <li><a href="#">🎥 Tutoriais</a></li>
                <li><a href="#">💡 Dicas</a></li>
              </ul>
            </div>
            
            <div class="link-column">
              <h4>🌐 Conecte-se</h4>
              <div class="social-links">
                <a href="#" class="social-link facebook" title="Facebook">
                  <i class="fab fa-facebook-f"></i>
                </a>
                <a href="#" class="social-link twitter" title="Twitter">
                  <i class="fab fa-twitter"></i>
                </a>
                <a href="#" class="social-link linkedin" title="LinkedIn">
                  <i class="fab fa-linkedin-in"></i>
                </a>
                <a href="https://www.instagram.com/clerky_ia" target="_blank" class="social-link instagram" title="Instagram">
                  <i class="fab fa-instagram"></i>
                </a>
                <a href="#" class="social-link youtube" title="YouTube">
                  <i class="fab fa-youtube"></i>
                </a>
                <a href="#" class="social-link github" title="GitHub">
                  <i class="fab fa-github"></i>
                </a>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Linha de Separação -->
        <div class="footer-divider"></div>
        
        <!-- Seção Inferior -->
        <div class="footer-bottom">
          <div class="footer-bottom-left">
                         <p>&copy; 2025 Clerky CRM. Todos os direitos reservados.</p>
            <div class="footer-links-inline">
              <a href="#">Política de Privacidade</a>
              <a href="#">Termos de Uso</a>
              <a href="#">Cookies</a>
            </div>
          </div>
          
          <div class="footer-bottom-right">
            <div class="footer-badges">
              <span class="badge-item">🔒 SSL Seguro</span>
              <span class="badge-item">🇧🇷 Feito no Brasil</span>
            </div>
            
            <div class="footer-tech">
              <span>Powered by</span>
              <div class="tech-icons">
                <i class="fab fa-node-js" title="Node.js"></i>
                <i class="fab fa-react" title="React"></i>
                <i class="fas fa-database" title="MongoDB"></i>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Efeitos de Background -->
      <div class="footer-effects">
        <div class="floating-shape shape-1"></div>
        <div class="floating-shape shape-2"></div>
        <div class="floating-shape shape-3"></div>
        <div class="floating-shape shape-4"></div>
        <div class="floating-shape shape-5"></div>
        <div class="floating-shape shape-6"></div>
        <div class="floating-shape shape-7"></div>
        <div class="floating-shape shape-8"></div>
      </div>
    </footer>
    
    <!-- Botão Flutuante WhatsApp Suporte -->
    <div class="whatsapp-float">
      <a href="https://wa.me/5562998448536" target="_blank" class="whatsapp-float-btn" title="WhatsApp Suporte">
        <i class="fab fa-whatsapp"></i>
        <span class="whatsapp-float-text">Suporte</span>
      </a>
    </div>
    
    <script>

    </script>
  `;
}

// Função para gerar CSS do footer padronizado
function getStandardFooterCSS() {
  return `
    .standard-footer {
      background: linear-gradient(135deg, #1a1a1a 0%, #2d3748 100%);
      color: #e2e8f0;
      position: relative;
            overflow: hidden;
      margin-top: auto;
    }
    
    .footer-content {
      max-width: 1200px;
      margin: 0 auto;
      padding: 30px 20px 15px;
            position: relative;
      z-index: 2;
    }
    
    .footer-main {
      display: grid;
      grid-template-columns: 1fr 2fr;
      gap: 40px;
      margin-bottom: 25px;
    }
    
    .footer-brand {
      display: flex;
      flex-direction: column;
      gap: 15px;
    }
    
    .footer-logo {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 1.8rem;
            font-weight: 700;
      color: #25D366;
    }
    
    .footer-logo i {
      font-size: 2.2rem;
    }
    
    .footer-description {
      color: #cbd5e0;
      line-height: 1.6;
      max-width: 300px;
    }
    

    
    .footer-links {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 30px;
    }
    
    .link-column h4 {
      color: #f7fafc;
      margin-bottom: 15px;
            font-size: 1rem;
      font-weight: 600;
    }
    
    .link-column ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    
    .link-column li {
      margin-bottom: 8px;
    }
    
    .link-column a {
      color: #cbd5e0;
      text-decoration: none;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      padding: 5px 0;
      font-size: 0.9rem;
    }
    
    .link-column a:hover {
      color: #25D366;
      transform: translateX(5px);
      text-shadow: 0 0 10px rgba(37, 211, 102, 0.3);
    }
    
    .social-links {
      display: flex;
      gap: 12px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    
    .social-link {
      width: 45px;
      height: 45px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      text-decoration: none;
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    
    .social-link::before {
      content: '';
            position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(45deg, transparent, rgba(255,255,255,0.1), transparent);
      transform: translateX(-100%);
      transition: transform 0.5s ease;
    }
    
    .social-link:hover::before {
      transform: translateX(100%);
    }
    
    .social-link:hover {
      transform: translateY(-3px) scale(1.1);
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
    }
    
    .social-link.facebook { background: linear-gradient(135deg, #1877f2, #42a5f5); }
    .social-link.twitter { background: linear-gradient(135deg, #1da1f2, #42a5f5); }
    .social-link.linkedin { background: linear-gradient(135deg, #0077b5, #42a5f5); }
    .social-link.instagram { background: linear-gradient(135deg, #e4405f, #f56040, #ffad00); }
    .social-link.youtube { background: linear-gradient(135deg, #ff0000, #ff4444); }
    .social-link.github { background: linear-gradient(135deg, #333, #666); }
    

    
    .footer-divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
      margin: 25px 0;
    }
    
    .footer-bottom {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 15px;
    }
    
    .footer-bottom-left p {
      color: #a0aec0;
      font-size: 0.85rem;
      margin-bottom: 8px;
    }
    
    .footer-links-inline {
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }
    
    .footer-links-inline a {
      color: #cbd5e0;
            text-decoration: none;
      font-size: 0.8rem;
      transition: color 0.3s ease;
    }
    
    .footer-links-inline a:hover {
      color: #25D366;
    }
    
    .footer-bottom-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
    }
    
    .footer-badges {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    
    .badge-item {
      background: rgba(37, 211, 102, 0.1);
      color: #25D366;
      padding: 5px 10px;
      border-radius: 15px;
      font-size: 0.75rem;
      font-weight: 500;
      border: 1px solid rgba(37, 211, 102, 0.2);
    }
    
    .footer-tech {
      display: flex;
      align-items: center;
      gap: 10px;
      color: #a0aec0;
      font-size: 0.8rem;
    }
    
    .tech-icons {
      display: flex;
      gap: 8px;
    }
    
    .tech-icons i {
      font-size: 1.2rem;
      transition: all 0.3s ease;
    }
    
    .tech-icons i:hover {
      color: #25D366;
      transform: scale(1.2);
    }
    
    /* Efeitos de Background */
    .footer-effects {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      overflow: hidden;
    }
    
    .floating-shape {
      position: absolute;
      border-radius: 50%;
      background: rgba(37, 211, 102, 0.1);
      animation: float 8s ease-in-out infinite;
      box-shadow: 0 0 20px rgba(37, 211, 102, 0.2);
      backdrop-filter: blur(5px);
    }
    
    .shape-1 {
      width: 100px;
      height: 100px;
      top: 20%;
      left: 10%;
      animation: float1 12s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.15) 0%, rgba(37, 211, 102, 0.05) 70%);
    }
    
    .shape-2 {
      width: 150px;
      height: 150px;
      top: 60%;
      right: 15%;
      animation: float2 15s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.12) 0%, rgba(37, 211, 102, 0.03) 80%);
    }
    
    .shape-3 {
      width: 80px;
      height: 80px;
      bottom: 30%;
      left: 70%;
      animation: float3 10s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.18) 0%, rgba(37, 211, 102, 0.04) 60%);
    }
    
    .shape-4 {
      width: 120px;
      height: 120px;
      top: 10%;
      right: 40%;
      animation: float4 18s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.1) 0%, rgba(37, 211, 102, 0.02) 90%);
    }
    
    .shape-5 {
      width: 60px;
      height: 60px;
      top: 80%;
      left: 5%;
      animation: float5 14s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.2) 0%, rgba(37, 211, 102, 0.03) 70%);
    }
    
    .shape-6 {
      width: 90px;
      height: 90px;
      top: 40%;
      left: 80%;
      animation: float6 16s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.08) 0%, rgba(37, 211, 102, 0.01) 85%);
    }
    
    .shape-7 {
      width: 70px;
      height: 70px;
      bottom: 10%;
      right: 5%;
      animation: float7 13s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.16) 0%, rgba(37, 211, 102, 0.04) 75%);
    }
    
    .shape-8 {
      width: 110px;
      height: 110px;
      top: 70%;
      left: 50%;
      animation: float8 20s ease-in-out infinite;
      background: radial-gradient(circle, rgba(37, 211, 102, 0.06) 0%, rgba(37, 211, 102, 0.01) 95%);
    }
    
    @keyframes float1 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.8;
      }
      25% { 
        transform: translateY(-30px) translateX(20px) rotate(90deg) scale(1.1); 
        opacity: 1;
      }
      50% { 
        transform: translateY(-20px) translateX(-15px) rotate(180deg) scale(0.9); 
        opacity: 0.6;
      }
      75% { 
        transform: translateY(-40px) translateX(10px) rotate(270deg) scale(1.05); 
        opacity: 0.9;
      }
    }
    
    @keyframes float2 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.7;
      }
      33% { 
        transform: translateY(-25px) translateX(-25px) rotate(120deg) scale(1.15); 
        opacity: 1;
      }
      66% { 
        transform: translateY(-35px) translateX(30px) rotate(240deg) scale(0.85); 
        opacity: 0.5;
      }
    }
    
    @keyframes float3 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.9;
      }
      20% { 
        transform: translateY(-15px) translateX(15px) rotate(72deg) scale(1.2); 
        opacity: 1;
      }
      40% { 
        transform: translateY(-25px) translateX(-10px) rotate(144deg) scale(0.8); 
        opacity: 0.7;
      }
      60% { 
        transform: translateY(-35px) translateX(20px) rotate(216deg) scale(1.1); 
        opacity: 0.8;
      }
      80% { 
        transform: translateY(-20px) translateX(-5px) rotate(288deg) scale(0.95); 
        opacity: 0.6;
      }
    }
    
    @keyframes float4 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.6;
      }
      25% { 
        transform: translateY(-40px) translateX(-20px) rotate(90deg) scale(1.25); 
        opacity: 1;
      }
      50% { 
        transform: translateY(-30px) translateX(25px) rotate(180deg) scale(0.75); 
        opacity: 0.4;
      }
      75% { 
        transform: translateY(-50px) translateX(-15px) rotate(270deg) scale(1.1); 
        opacity: 0.8;
      }
    }
    
    @keyframes float5 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.8;
      }
      20% { 
        transform: translateY(-20px) translateX(25px) rotate(60deg) scale(1.3); 
        opacity: 1;
      }
      40% { 
        transform: translateY(-30px) translateX(-15px) rotate(120deg) scale(0.7); 
        opacity: 0.6;
      }
      60% { 
        transform: translateY(-25px) translateX(20px) rotate(180deg) scale(1.1); 
        opacity: 0.9;
      }
      80% { 
        transform: translateY(-35px) translateX(-10px) rotate(240deg) scale(0.9); 
        opacity: 0.7;
      }
    }
    
    @keyframes float6 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.5;
      }
      30% { 
        transform: translateY(-35px) translateX(-30px) rotate(108deg) scale(1.4); 
        opacity: 1;
      }
      60% { 
        transform: translateY(-45px) translateX(20px) rotate(216deg) scale(0.6); 
        opacity: 0.3;
      }
      90% { 
        transform: translateY(-20px) translateX(-25px) rotate(324deg) scale(1.2); 
        opacity: 0.8;
      }
    }
    
    @keyframes float7 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.9;
      }
      25% { 
        transform: translateY(-15px) translateX(30px) rotate(45deg) scale(1.25); 
        opacity: 1;
      }
      50% { 
        transform: translateY(-40px) translateX(-20px) rotate(90deg) scale(0.8); 
        opacity: 0.5;
      }
      75% { 
        transform: translateY(-25px) translateX(15px) rotate(135deg) scale(1.15); 
        opacity: 0.8;
      }
    }
    
    @keyframes float8 {
      0%, 100% { 
        transform: translateY(0) translateX(0) rotate(0deg) scale(1); 
        opacity: 0.4;
      }
      16% { 
        transform: translateY(-30px) translateX(25px) rotate(45deg) scale(1.35); 
        opacity: 1;
      }
      32% { 
        transform: translateY(-50px) translateX(-15px) rotate(90deg) scale(0.65); 
        opacity: 0.2;
      }
      48% { 
        transform: translateY(-35px) translateX(30px) rotate(135deg) scale(1.2); 
        opacity: 0.7;
      }
      64% { 
        transform: translateY(-45px) translateX(-25px) rotate(180deg) scale(0.8); 
        opacity: 0.3;
      }
      80% { 
        transform: translateY(-20px) translateX(20px) rotate(225deg) scale(1.1); 
        opacity: 0.6;
      }
      96% { 
        transform: translateY(-40px) translateX(-10px) rotate(270deg) scale(0.9); 
        opacity: 0.4;
      }
    }
    
    /* Responsividade */
    @media (max-width: 768px) {
      .footer-content {
        padding: 40px 15px 15px;
      }
      
      .footer-main {
        grid-template-columns: 1fr;
        gap: 40px;
      }
      
      .footer-links {
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 30px;
      }
      
      .footer-stats {
        justify-content: center;
      }
      
      .stat-item {
        flex: 1;
        min-width: 80px;
      }
      
      .footer-bottom {
        flex-direction: column;
        text-align: center;
      }
      
      .footer-bottom-right {
        align-items: center;
      }
      
      .social-links {
        justify-content: center;
      }
      
      .floating-shape {
        display: none;
      }
    }
    
    @media (max-width: 480px) {
      .footer-links {
        grid-template-columns: 1fr;
      }
      
      .footer-stats {
        flex-direction: column;
        align-items: center;
      }
      
      .newsletter-form {
        flex-direction: column;
      }
    }
    
    /* Botão Flutuante WhatsApp */
    .whatsapp-float {
      position: fixed;
      bottom: 30px;
      right: 30px;
      z-index: 1000;
    }
    
    .whatsapp-float-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      color: white;
      padding: 15px 20px;
      border-radius: 50px;
      text-decoration: none;
      font-weight: 600;
      font-size: 1rem;
      box-shadow: 0 8px 25px rgba(37, 211, 102, 0.3);
      transition: all 0.3s ease;
      animation: whatsapp-pulse 2s infinite;
    }
    
    .whatsapp-float-btn:hover {
      transform: translateY(-3px) scale(1.05);
      box-shadow: 0 12px 35px rgba(37, 211, 102, 0.4);
      color: white;
      text-decoration: none;
    }
    
    .whatsapp-float-btn i {
      font-size: 1.5rem;
    }
    
    .whatsapp-float-text {
      white-space: nowrap;
    }
    
    @keyframes whatsapp-pulse {
      0% {
        box-shadow: 0 8px 25px rgba(37, 211, 102, 0.3);
      }
      50% {
        box-shadow: 0 8px 25px rgba(37, 211, 102, 0.6);
      }
      100% {
        box-shadow: 0 8px 25px rgba(37, 211, 102, 0.3);
      }
    }
    
    /* Responsividade do botão WhatsApp */
    @media (max-width: 768px) {
      .whatsapp-float {
        bottom: 20px;
        right: 20px;
      }
      
      .whatsapp-float-btn {
        padding: 12px 16px;
        font-size: 0.9rem;
      }
      
      .whatsapp-float-btn i {
        font-size: 1.3rem;
      }
    }
    
    @media (max-width: 480px) {
      .whatsapp-float-text {
        display: none;
      }
      
      .whatsapp-float-btn {
        padding: 15px;
        border-radius: 50%;
      }
    }
  `;
}

// Função para gerar CSS do header padronizado
function getStandardHeaderCSS() {
  return `
    .standard-header {
      background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
      color: white;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      position: sticky;
      top: 0;
      z-index: 1000;
    }
    
    .header-content {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 20px;
    }
    
    .header-left {
      display: flex;
      align-items: center;
      gap: 15px;
    }
    
    .header-icon {
      font-size: 2.5rem;
      background: rgba(255,255,255,0.2);
      padding: 15px;
      border-radius: 15px;
      backdrop-filter: blur(10px);
    }
    
    .header-text {
      display: flex;
      flex-direction: column;
    }
    
    .header-logo {
      height: 40px;
      width: auto;
      max-width: 200px;
      object-fit: contain;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
      transition: all 0.3s ease;
    }
    
    .header-logo:hover {
      transform: scale(1.05);
      filter: drop-shadow(0 4px 8px rgba(0,0,0,0.2));
    }
    
    .header-subtitle {
      font-size: 1rem;
      opacity: 0.9;
      margin: 5px 0 0 0;
    }
    
    .header-nav {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    
    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 18px;
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      color: white;
      text-decoration: none;
      font-weight: 500;
      transition: all 0.3s ease;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
    }
    
    .nav-item:hover {
      background: rgba(255,255,255,0.2);
            transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }
    
    .nav-item.active {
      background: rgba(255,255,255,0.25);
      border-color: rgba(255,255,255,0.3);
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    
    .nav-item.logout {
      background: rgba(220,53,69,0.2);
      border-color: rgba(220,53,69,0.3);
    }
    
    .nav-item.logout:hover {
      background: rgba(220,53,69,0.3);
    }
    
    .nav-item i {
      font-size: 1.1rem;
    }
    
    @media (max-width: 768px) {
      .header-content {
        flex-direction: column;
        text-align: center;
      }
      
      .header-nav {
        justify-content: center;
        width: 100%;
      }
      
      .nav-item span {
        display: none;
      }
      
      .nav-item {
        padding: 12px;
      }
    }
  `;
}

// Função para gerar HTML da página de disparo
function getDisparoHTML() {
  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Disparo em Massa - Clerky CRM</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
            background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
            min-height: 100vh;
            line-height: 1.6;
            color: #1e293b;
        }
        
        /* Scrollbar personalizada */
        ::-webkit-scrollbar {
            width: 8px;
        }
        
        ::-webkit-scrollbar-track {
            background: rgba(226, 232, 240, 0.3);
            border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb {
            background: linear-gradient(180deg, #25D366, #128C7E);
            border-radius: 4px;
        }
        
        ::-webkit-scrollbar-thumb:hover {
            background: linear-gradient(180deg, #128C7E, #075e54);
        }
        
        ${getStandardHeaderCSS()}
        ${getStandardFooterCSS()}
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: linear-gradient(135deg, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.95) 100%);
            border-radius: 24px;
            box-shadow: 0 25px 50px rgba(0,0,0,0.08);
            overflow: hidden;
            margin-top: 20px;
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.3);
        }
        
        .main-content {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 40px;
            padding: 40px;
        }
        
        .left-panel, .right-panel {
            background: linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%);
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 15px 35px rgba(0,0,0,0.05);
            border: 1px solid rgba(255,255,255,0.2);
            backdrop-filter: blur(10px);
        }
        
        .section-title {
            font-size: 1.6rem;
            font-weight: 700;
            margin-bottom: 25px;
            background: linear-gradient(135deg, #1e293b 0%, #475569 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            display: flex;
            align-items: center;
            gap: 12px;
            position: relative;
        }
        
        .section-title::after {
            content: '';
            position: absolute;
            bottom: -8px;
            left: 0;
            width: 60px;
            height: 3px;
            background: linear-gradient(90deg, #25D366, #128C7E);
            border-radius: 2px;
        }
        
        .form-group {
            margin-bottom: 25px;
            position: relative;
        }
        
        .form-label {
            display: block;
            margin-bottom: 10px;
            font-weight: 600;
            color: #374151;
            font-size: 0.95rem;
            text-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        
        .form-input, .form-textarea, .form-select {
            width: 100%;
            padding: 15px 18px;
            border: 2px solid rgba(226, 232, 240, 0.8);
            border-radius: 12px;
            font-size: 14px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(10px);
            box-shadow: 0 2px 8px rgba(0,0,0,0.04);
        }
        
        .form-input:focus, .form-textarea:focus, .form-select:focus {
            outline: none;
            border-color: #25D366;
            box-shadow: 0 0 0 4px rgba(37, 211, 102, 0.15);
            background: rgba(255, 255, 255, 1);
            transform: translateY(-1px);
        }
        
        .form-textarea {
            min-height: 120px;
            resize: vertical;
            font-family: inherit;
            line-height: 1.6;
        }
        
        .file-upload {
            position: relative;
            display: inline-block;
            width: 100%;
        }
        
        .file-input {
            position: absolute;
            opacity: 0;
            width: 100%;
            height: 100%;
            cursor: pointer;
        }
        
        .file-label {
            display: block;
            padding: 20px 15px;
            border: 2px dashed rgba(37, 211, 102, 0.4);
            border-radius: 12px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            background: linear-gradient(135deg, rgba(37, 211, 102, 0.05) 0%, rgba(18, 140, 126, 0.03) 100%);
            backdrop-filter: blur(10px);
            font-weight: 500;
            color: #25D366;
        }
        
        .file-label:hover {
            background: linear-gradient(135deg, rgba(37, 211, 102, 0.1) 0%, rgba(18, 140, 126, 0.08) 100%);
            border-color: #25D366;
            transform: translateY(-2px);
            box-shadow: 0 8px 25px rgba(37, 211, 102, 0.15);
        }
        
        .contatos-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 18px;
            max-height: 450px;
            overflow-y: auto;
            border: 2px solid rgba(226, 232, 240, 0.6);
            border-radius: 16px;
            padding: 20px;
            background: rgba(255, 255, 255, 0.8);
            backdrop-filter: blur(10px);
            box-shadow: inset 0 2px 8px rgba(0,0,0,0.04);
        }
        
        .contato-card {
            background: linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%);
            border: 2px solid rgba(226, 232, 240, 0.8);
            border-radius: 14px;
            padding: 18px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.04);
        }
        
        .contato-card:hover {
            border-color: #25D366;
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(37, 211, 102, 0.15);
            background: linear-gradient(135deg, rgba(255,255,255,1) 0%, rgba(248,250,252,0.95) 100%);
        }
        
        .contato-card.selected {
            border-color: #25D366;
            background: linear-gradient(135deg, rgba(37, 211, 102, 0.1) 0%, rgba(18, 140, 126, 0.05) 100%);
            box-shadow: 0 8px 25px rgba(37, 211, 102, 0.2);
        }
        
        .contato-nome {
            font-weight: 600;
            color: #2c3e50;
            margin-bottom: 5px;
        }
        
        .contato-telefone {
            color: #7f8c8d;
            font-size: 0.9rem;
            margin-bottom: 5px;
        }
        
        .contato-badges {
            display: flex;
            gap: 5px;
            flex-wrap: wrap;
        }
        
        .badge {
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .badge-status {
            background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
            color: #1e40af;
            border: 1px solid rgba(59, 130, 246, 0.2);
        }
        
        .badge-priority {
            background: linear-gradient(135deg, #fed7aa 0%, #fdba74 100%);
            color: #c2410c;
            border: 1px solid rgba(245, 158, 11, 0.2);
        }
        
        .filtros-container {
            display: flex;
            gap: 18px;
            margin-bottom: 25px;
            flex-wrap: wrap;
            background: rgba(255, 255, 255, 0.7);
            padding: 20px;
            border-radius: 16px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(226, 232, 240, 0.4);
        }
        
        .filtro-group {
            flex: 1;
            min-width: 160px;
        }
        
        .btn {
            padding: 14px 28px;
            border: none;
            border-radius: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-size: 14px;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            text-decoration: none;
            position: relative;
            overflow: hidden;
            backdrop-filter: blur(10px);
        }
        
        .btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
            transition: left 0.5s ease;
        }
        
        .btn:hover::before {
            left: 100%;
        }
        
        .btn-primary {
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(37, 211, 102, 0.3);
        }
        
        .btn-primary:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(37, 211, 102, 0.4);
        }
        
        .btn-secondary {
            background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(107, 114, 128, 0.3);
        }
        
        .btn-secondary:hover {
            background: linear-gradient(135deg, #5a6268 0%, #374151 100%);
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(107, 114, 128, 0.4);
        }
        
        .btn-danger {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3);
        }
        
        .btn-danger:hover {
            background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(239, 68, 68, 0.4);
        }
        
        .btn-warning {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            color: white;
            box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3);
        }
        
        .btn-warning:hover {
            background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(245, 158, 11, 0.4);
        }
        
        .btn-small {
            padding: 10px 18px;
            font-size: 12px;
        }
        
        .actions-container {
            display: flex;
            gap: 18px;
            margin-top: 35px;
            justify-content: center;
            background: rgba(255, 255, 255, 0.8);
            padding: 25px;
            border-radius: 20px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(226, 232, 240, 0.4);
            box-shadow: 0 8px 25px rgba(0,0,0,0.05);
        }
        
        .loading {
            display: none;
            text-align: center;
            padding: 30px;
            background: rgba(255,255,255,0.9);
            border-radius: 16px;
            backdrop-filter: blur(10px);
            margin: 20px 0;
        }
        
        .spinner {
            width: 40px;
            height: 40px;
            margin: 0 auto 15px;
            position: relative;
        }
        
        .spinner::before,
        .spinner::after {
            content: '';
            position: absolute;
            border-radius: 50%;
        }
        
        .spinner::before {
            width: 100%;
            height: 100%;
            background: conic-gradient(from 0deg, transparent, #25D366, transparent);
            animation: spin 1.5s linear infinite;
        }
        
        .spinner::after {
            width: 70%;
            height: 70%;
            background: white;
            top: 15%;
            left: 15%;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .alert {
            padding: 18px 20px;
            border-radius: 12px;
            margin: 18px 0;
            font-weight: 500;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
            position: relative;
            overflow: hidden;
        }
        
        .alert::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 4px;
            height: 100%;
        }
        
        .alert-success {
            background: linear-gradient(135deg, rgba(34, 197, 94, 0.1) 0%, rgba(22, 163, 74, 0.05) 100%);
            color: #166534;
            border-color: rgba(34, 197, 94, 0.2);
        }
        
        .alert-success::before {
            background: linear-gradient(180deg, #22c55e, #16a34a);
        }
        
        .alert-error {
            background: linear-gradient(135deg, rgba(239, 68, 68, 0.1) 0%, rgba(220, 38, 38, 0.05) 100%);
            color: #991b1b;
            border-color: rgba(239, 68, 68, 0.2);
        }
        
        .alert-error::before {
            background: linear-gradient(180deg, #ef4444, #dc2626);
        }
        
        .alert-warning {
            background: linear-gradient(135deg, rgba(245, 158, 11, 0.1) 0%, rgba(217, 119, 6, 0.05) 100%);
            color: #92400e;
            border-color: rgba(245, 158, 11, 0.2);
        }
        
        .alert-warning::before {
            background: linear-gradient(180deg, #f59e0b, #d97706);
        }
        
        .stats-container {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 18px;
            margin-bottom: 25px;
        }
        
        .stat-card {
            background: linear-gradient(135deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.9) 100%);
            padding: 20px;
            border-radius: 16px;
            text-align: center;
            border: 2px solid rgba(226, 232, 240, 0.6);
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 15px rgba(0,0,0,0.05);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: relative;
            overflow: hidden;
        }
        
        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #25D366, #128C7E);
        }
        
        .stat-card:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(37, 211, 102, 0.15);
        }
        
        .stat-number {
            font-size: 2rem;
            font-weight: 800;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 5px;
        }
        
        .stat-label {
            font-size: 0.9rem;
            color: #6b7280;
            font-weight: 500;
        }
        
        .resultados-container {
            max-height: 350px;
            overflow-y: auto;
            border: 2px solid rgba(226, 232, 240, 0.6);
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.9);
            backdrop-filter: blur(10px);
            box-shadow: inset 0 2px 8px rgba(0,0,0,0.04);
        }
        
        .resultado-item {
            padding: 15px 20px;
            border-bottom: 1px solid rgba(226, 232, 240, 0.4);
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: all 0.2s ease;
        }
        
        .resultado-item:hover {
            background: rgba(255, 255, 255, 0.5);
        }
        
        .resultado-item:last-child {
            border-bottom: none;
        }
        
        .resultado-sucesso {
            background: linear-gradient(135deg, rgba(34, 197, 94, 0.05) 0%, rgba(22, 163, 74, 0.02) 100%);
        }
        
        .resultado-erro {
            background: linear-gradient(135deg, rgba(239, 68, 68, 0.05) 0%, rgba(220, 38, 38, 0.02) 100%);
        }
        
        .status-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            margin-right: 12px;
            font-size: 12px;
            color: white;
            font-weight: bold;
        }
        
        .status-sucesso {
            background: linear-gradient(135deg, #22c55e, #16a34a);
            box-shadow: 0 2px 8px rgba(34, 197, 94, 0.3);
        }
        
        .status-erro {
            background: linear-gradient(135deg, #ef4444, #dc2626);
            box-shadow: 0 2px 8px rgba(239, 68, 68, 0.3);
        }
        
        .tabs-container {
            display: flex;
            background: rgba(248, 250, 252, 0.8);
            border-radius: 10px;
            padding: 4px;
            margin-bottom: 25px;
            border: 1px solid rgba(226, 232, 240, 0.4);
            gap: 4px;
        }
        
        /* Responsividade Moderna */
        @media (max-width: 1200px) {
            .main-content {
                grid-template-columns: 1fr;
                gap: 30px;
                padding: 30px;
            }
            
            .container {
                max-width: 100%;
                margin: 10px;
            }
        }
        
        @media (max-width: 768px) {
            .main-content {
                padding: 20px;
                gap: 25px;
            }
            
            .left-panel, .right-panel {
                padding: 25px;
                border-radius: 16px;
            }
            
            .section-title {
                font-size: 1.4rem;
            margin-bottom: 20px;
            }
            
            .form-input, .form-textarea, .form-select {
                padding: 12px 15px;
                font-size: 16px; /* Melhor para mobile */
            }
            
            .btn {
                padding: 12px 20px;
                font-size: 14px;
            }
            
            .contatos-grid {
                grid-template-columns: 1fr;
                gap: 15px;
                padding: 15px;
            }
            
            .stats-container {
                grid-template-columns: repeat(2, 1fr);
                gap: 15px;
            }
            
            .actions-container {
                flex-direction: column;
                gap: 12px;
            }
            
            .filtros-container {
                flex-direction: column;
                gap: 12px;
            }
        }
        
        @media (max-width: 480px) {
            .main-content {
                padding: 15px;
                gap: 20px;
            }
            
            .left-panel, .right-panel {
                padding: 20px;
                border-radius: 12px;
            }
            
            .section-title {
                font-size: 1.2rem;
                margin-bottom: 15px;
            }
            
            .form-group {
                margin-bottom: 20px;
            }
            
            .stats-container {
                grid-template-columns: 1fr;
                gap: 12px;
            }
            
            .stat-card {
                padding: 15px;
            }
            
            .stat-number {
                font-size: 1.6rem;
            }
            
            .btn {
                padding: 10px 16px;
                font-size: 13px;
            }
            
            .btn-small {
                padding: 8px 12px;
                font-size: 11px;
            }
            
            /* Responsividade dos botões de tab */
            .tab-btn {
                padding: 10px 14px;
                font-size: 13px;
                gap: 6px;
            }
            
            .tabs-container {
                padding: 3px;
                gap: 3px;
            }
        }
        }
        
        .tab-btn {
            flex: 1;
            padding: 14px 20px;
            border: none;
            background: rgba(255, 255, 255, 0.8);
            border-radius: 10px;
            cursor: pointer;
            font-weight: 500;
            font-size: 14px;
            transition: all 0.2s ease;
            color: #64748b;
            border: 1px solid rgba(226, 232, 240, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            position: relative;
        }
        
        .tab-btn i {
            font-size: 15px;
            opacity: 0.7;
            transition: opacity 0.2s ease;
        }
        
        .tab-btn:hover {
            background: rgba(255, 255, 255, 0.95);
            color: #374151;
            border-color: rgba(37, 211, 102, 0.3);
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }
        
        .tab-btn:hover i {
            opacity: 1;
        }
        
        .tab-btn.active {
            background: #25D366;
            color: white;
            border-color: #25D366;
            box-shadow: 0 4px 12px rgba(37, 211, 102, 0.25);
            transform: translateY(-1px);
        }
        
        .tab-btn.active i {
            opacity: 1;
        }
        
        /* Estilos para Modal */
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
            backdrop-filter: blur(5px);
        }
        
        .modal-content {
            background-color: #fefefe;
            margin: 5% auto;
            padding: 30px;
            border-radius: 15px;
            width: 90%;
            max-width: 500px;
            position: relative;
            box-shadow: 0 20px 40px rgba(0,0,0,0.2);
            animation: modalSlideIn 0.3s ease-out;
        }
        
        @keyframes modalSlideIn {
            from { transform: translateY(-50px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }
        
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #e1e8ed;
        }
        
        .modal-title {
            font-size: 1.3rem;
            font-weight: 600;
            color: #2c3e50;
        }
        
        .close {
            color: #aaa;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
            transition: color 0.3s ease;
        }
        
        .close:hover {
            color: #000;
        }
        
        .modal-body {
            margin-bottom: 20px;
        }
        
        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            padding-top: 15px;
            border-top: 2px solid #e1e8ed;
        }
        
        .tab-btn:hover:not(.active) {
            background: rgba(255, 255, 255, 0.9);
            color: #374151;
            transform: translateY(-1px);
            box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            border: 1px solid rgba(255, 255, 255, 0.5);
        }
        
        .tab-btn:active {
            transform: translateY(0);
            transition: transform 0.1s ease;
        }
        
        .form-help {
            margin-top: 8px;
            padding: 10px;
            background: #f8f9fa;
            border-left: 4px solid #25D366;
            border-radius: 5px;
            font-size: 0.85rem;
            color: #666;
        }
        
        .numeros-container {
            margin-top: 15px;
            padding: 15px;
            border: 2px solid #e1e8ed;
            border-radius: 10px;
            background: white;
        }
        
        .numeros-lista {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
        }
        
        .numero-chip {
            display: inline-flex;
            align-items: center;
            padding: 5px 10px;
            border-radius: 15px;
            font-size: 0.85rem;
            font-weight: 500;
        }
        
        .numero-valido {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        
        .numero-invalido {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        
        .template-preview {
            margin-top: 15px;
            padding: 15px;
            border: 2px solid #e1e8ed;
            border-radius: 10px;
            background: #f8f9fa;
        }
        
        .template-preview h4 {
            color: #25D366;
            margin-bottom: 10px;
            font-size: 0.9rem;
            font-weight: 600;
        }
        
        .template-preview-content {
            background: white;
            padding: 12px;
            border-radius: 8px;
            border-left: 4px solid #25D366;
            font-size: 0.9rem;
            color: #333;
        }

        /* Estilos do Gravador de Áudio */
        .audio-recorder {
            background: #f8f9fa;
            border: 2px solid #e9ecef;
            border-radius: 12px;
            padding: 20px;
            margin: 10px 0;
        }

        .recorder-controls {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }

        .btn-record {
            background: #dc3545;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.3s ease;
        }

        .btn-record:hover:not(:disabled) {
            background: #c82333;
            transform: translateY(-2px);
        }

        .btn-record:disabled {
            background: #6c757d;
            cursor: not-allowed;
        }

        .btn-stop {
            background: #6c757d;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.3s ease;
        }

        .btn-stop:hover:not(:disabled) {
            background: #5a6268;
            transform: translateY(-2px);
        }

        .btn-stop:disabled {
            background: #adb5bd;
            cursor: not-allowed;
        }

        .btn-play {
            background: #28a745;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 8px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.3s ease;
        }

        .btn-play:hover:not(:disabled) {
            background: #218838;
            transform: translateY(-2px);
        }

        .btn-play:disabled {
            background: #adb5bd;
            cursor: not-allowed;
        }

        .recorder-status {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: white;
            padding: 10px 15px;
            border-radius: 8px;
            border: 1px solid #dee2e6;
            margin-bottom: 10px;
        }

        #status-gravacao {
            font-weight: 500;
            color: #495057;
        }

        .recorder-waveform {
            background: white;
            border: 1px solid #dee2e6;
            border-radius: 8px;
            padding: 10px;
            text-align: center;
        }

        #canvas-waveform {
            border-radius: 4px;
        }

        .recording-pulse {
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }

        /* Estilos para Progresso */
        .progress-section {
            margin: 20px 0;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 10px;
            border: 2px solid #e1e8ed;
        }

        .progress-bar {
            background: #e1e8ed;
            border-radius: 10px;
            height: 20px;
            overflow: hidden;
            margin: 10px 0;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(135deg, #25D366 0%, #128C7E 100%);
            transition: width 0.3s ease;
            border-radius: 10px;
            width: 0%;
        }

        .progress-info {
            text-align: center;
            font-size: 0.9rem;
            color: #666;
            margin-top: 5px;
        }

        /* Estilos para Números Inválidos */
        .invalid-numbers-section {
            margin: 20px 0;
            padding: 15px;
            background: #fff5f5;
            border-radius: 10px;
            border: 2px solid #fecaca;
        }

        .invalid-numbers-list {
            max-height: 200px;
            overflow-y: auto;
            margin-top: 10px;
        }

        .invalid-number-item {
            padding: 8px 12px;
            margin: 5px 0;
            background: white;
            border-radius: 8px;
            border: 1px solid #fecaca;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .invalid-number-info {
            flex: 1;
        }

        .invalid-number-name {
            font-weight: 600;
            color: #dc3545;
        }

        .invalid-number-phone {
            font-size: 0.85rem;
            color: #666;
        }

        .invalid-number-error {
            font-size: 0.8rem;
            color: #999;
            font-style: italic;
        }

        .btn-control-disparo {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            border-radius: 50px;
            padding: 12px 20px;
            font-weight: 600;
            font-size: 1rem;
        }
        
        @media (max-width: 768px) {
            .main-content {
                grid-template-columns: 1fr;
                gap: 20px;
                padding: 20px;
            }
            
            .contatos-grid {
                grid-template-columns: 1fr;
            }
            
            .actions-container {
                flex-direction: column;
            }
            
            .filtros-container {
                flex-direction: column;
            }
        }
    </style>
</head>
<body>
    ${getStandardHeader('Disparo em Massa', '📤', 'disparo')}
    
    <div class="container">
        
        <div class="main-content">
            <div class="left-panel">
                <h2 class="section-title">
                    ⚙️ Configurações da Mensagem
                </h2>
                
                <div class="form-group">
                    <label class="form-label">📋 Tipo de Template</label>
                    <select id="tipoTemplate" class="form-select" onchange="alterarTemplate()">
                        <option value="texto">📝 Apenas Texto</option>
                        <option value="imagem">🖼️ Imagem</option>
                        <option value="imagem-legenda">🖼️ Imagem + Legenda</option>
                        <option value="audio">🎵 Áudio</option>
                        <option value="arquivo">📎 Arquivo</option>
                        <option value="arquivo-legenda">📎 Arquivo + Legenda</option>
                    </select>
                </div>
                
                <!-- Templates Salvos -->
                <div class="form-group">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <label class="form-label">💾 Templates Salvos</label>
                        <button type="button" class="btn btn-small btn-secondary" onclick="abrirModalSalvarTemplate()">
                            💾 Salvar Atual
                        </button>
                    </div>
                    <select id="templatesSalvos" class="form-select" onchange="carregarTemplate()">
                        <option value="">Selecione um template...</option>
                    </select>
                    <div id="template-info" style="margin-top: 8px; font-size: 0.85rem; color: #666; display: none;">
                        <div id="template-descricao"></div>
                        <div id="template-stats" style="margin-top: 4px; font-size: 0.8rem; color: #999;"></div>
                    </div>
                    <div id="template-actions" style="margin-top: 10px; display: none;">
                        <button type="button" class="btn btn-small btn-primary" onclick="carregarTemplate()" style="margin-right: 5px;">
                            📋 Carregar
                        </button>
                        <button type="button" class="btn btn-small btn-warning" onclick="abrirModalEditarTemplate()" style="margin-right: 5px;">
                            ✏️ Editar
                        </button>
                        <button type="button" class="btn btn-small btn-danger" onclick="excluirTemplate()">
                            🗑️ Excluir
                        </button>
                    </div>
                </div>
                
                <div class="form-group" id="grupo-mensagem">
                    <label class="form-label">📝 Mensagem</label>
                    <textarea 
                        id="mensagem" 
                        class="form-textarea" 
                        placeholder="Digite sua mensagem aqui..."
                        required
                    ></textarea>
                </div>
                
                <div class="form-group" id="grupo-arquivo" style="display: none;">
                    <label class="form-label" id="label-arquivo">📎 Anexo</label>
                    <div class="file-upload">
                        <input type="file" id="arquivo" class="file-input">
                        <label for="arquivo" class="file-label" id="file-label-text">
                            📎 Clique para selecionar arquivo
                        </label>
                    </div>
                    <div id="arquivo-info" style="margin-top: 10px; font-size: 0.9rem; color: #666;"></div>
                </div>

                <!-- Gravador de Áudio -->
                <div class="form-group" id="grupo-gravador" style="display: none;">
                    <label class="form-label">🎙️ Gravar Áudio</label>
                    <div class="audio-recorder">
                        <div class="recorder-controls">
                            <button type="button" id="btn-gravar" class="btn btn-record" onclick="iniciarGravacao()">
                                🎙️ Gravar
                            </button>
                            <button type="button" id="btn-parar" class="btn btn-stop" onclick="pararGravacao()" disabled>
                                ⏹️ Parar
                            </button>
                            <button type="button" id="btn-reproduzir" class="btn btn-play" onclick="reproduzirGravacao()" disabled>
                                ▶️ Reproduzir
                            </button>
                            <button type="button" id="btn-limpar-audio" class="btn btn-secondary" onclick="limparGravacao()" disabled>
                                🗑️ Limpar
                            </button>
                        </div>
                        <div class="recorder-status">
                            <div id="status-gravacao">Pronto para gravar</div>
                        </div>
                        <div class="recorder-waveform" id="waveform" style="display: none;">
                            <canvas id="canvas-waveform" width="300" height="50"></canvas>
                        </div>
                        <audio id="audio-preview" controls style="display: none; width: 100%; margin-top: 10px;"></audio>
                    </div>
                    <div class="form-help">
                        💡 Grave seu áudio diretamente pelo navegador. O áudio será salvo automaticamente quando você parar a gravação.
                    </div>
                </div>
                
                <div class="form-group" id="grupo-legenda" style="display: none;">
                    <label class="form-label">📝 Legenda</label>
                    <textarea 
                        id="legenda" 
                        class="form-textarea" 
                        placeholder="Digite a legenda para o arquivo..."
                        rows="3"
                    ></textarea>
                </div>
                
                <div class="form-group">
                    <label class="form-label">🕐 Agendar Envio (Opcional)</label>
                    <input 
                        type="datetime-local" 
                        id="agendarPara" 
                        class="form-input"
                    >
                </div>
                
                <div class="form-group">
                    <label class="form-label">⏱️ Intervalo entre Mensagens (segundos)</label>
                    <select id="intervalo" class="form-select">
                        <option value="1">1 segundo</option>
                        <option value="2">2 segundos</option>
                        <option value="3" selected>3 segundos</option>
                        <option value="5">5 segundos</option>
                        <option value="10">10 segundos</option>
                        <option value="30">30 segundos</option>
                        <option value="60">1 minuto</option>
                    </select>
                </div>
                
                <div class="stats-container">
                    <div class="stat-card">
                        <div class="stat-number" id="totalContatos">0</div>
                        <div class="stat-label">Total</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-number" id="contatosSelecionados">0</div>
                        <div class="stat-label">Selecionados</div>
                    </div>
                </div>
                
                <!-- Preview do Template -->
                <div id="template-preview" class="template-preview" style="display: none;">
                    <h4>👀 Preview da Mensagem</h4>
                    <div id="template-preview-content" class="template-preview-content"></div>
                </div>
                
                <div class="actions-container">
                    <button class="btn btn-primary" onclick="enviarDisparo()" id="btn-enviar-disparo">
                        📤 Enviar Disparo
                    </button>
                    <button class="btn btn-danger" onclick="pararDisparo()" id="btn-parar-disparo" style="display: none;">
                        ⏹️ Parar Disparo
                    </button>
                    <button class="btn btn-secondary" onclick="limparSelecao()">
                        🗑️ Limpar Seleção
                    </button>
                </div>
                
                <div class="loading" id="loading">
                    <div class="spinner"></div>
                    <p>Enviando mensagens...</p>
                </div>
                
                <!-- Seção de Progresso da Validação -->
                <div id="validacao-progress" class="progress-section" style="display: none;">
                    <h3 class="section-title">🔍 Validação de Números</h3>
                    <div class="progress-bar">
                        <div class="progress-fill" id="validacao-progress-fill"></div>
                    </div>
                    <div class="progress-info">
                        <span id="validacao-progress-text">0 / 0 validados</span>
                    </div>
                </div>
                
                <!-- Seção de Progresso do Envio -->
                <div id="envio-progress" class="progress-section" style="display: none;">
                    <h3 class="section-title">📤 Enviando Mensagens</h3>
                    <div class="progress-bar">
                        <div class="progress-fill" id="envio-progress-fill"></div>
                    </div>
                    <div class="progress-info">
                        <span id="envio-progress-text">0 / 0 enviados</span>
                    </div>
                </div>
                
                <!-- Seção de Números Inválidos -->
                <div id="numeros-invalidos-section" class="invalid-numbers-section" style="display: none;">
                    <h3 class="section-title">❌ Números Sem WhatsApp</h3>
                    <div id="numeros-invalidos-list" class="invalid-numbers-list"></div>
                </div>
                
                <div id="alertas"></div>
            </div>
            
            <div class="right-panel">
                <h2 class="section-title">
                    👥 Selecionar Contatos
                </h2>
                
                <!-- Tabs para alternar entre modos -->
                <div class="tabs-container">
                    <button class="tab-btn active" onclick="alternarModo('contatos')" id="tab-contatos">
                        <i class="fas fa-users"></i>
                        Da Lista
                    </button>
                    <button class="tab-btn" onclick="alternarModo('numeros')" id="tab-numeros">
                        <i class="fas fa-mobile-alt"></i>
                        Números Manuais
                    </button>
                </div>
                
                <!-- Modo: Contatos da Lista -->
                <div id="modo-contatos">
                    <div class="filtros-container">
                        <div class="filtro-group">
                            <label class="form-label">🔍 Buscar</label>
                            <input 
                                type="text" 
                                id="buscarContato" 
                                class="form-input" 
                                placeholder="Nome ou telefone..."
                                onkeyup="filtrarContatos()"
                            >
                        </div>
                        <div class="filtro-group">
                            <label class="form-label">📊 Status</label>
                            <select id="filtroStatus" class="form-select" onchange="filtrarContatos()">
                                <option value="">Todos</option>
                                <option value="novo">🆕 Novo Cliente</option>
                                <option value="andamento">⏳ Em Andamento</option>
                                <option value="aprovado">✅ Aprovado</option>
                                <option value="reprovado">❌ Reprovado</option>
                            </select>
                        </div>
                    </div>
                </div>
                
                <!-- Modo: Números Manuais -->
                <div id="modo-numeros" style="display: none;">
                    <div class="form-group">
                        <label class="form-label">📱 Números de Telefone</label>
                        <textarea 
                            id="numerosManuais" 
                            class="form-textarea" 
                            placeholder="Digite os números, um por linha:&#10;5511999999999&#10;5511888888888&#10;5511777777777&#10;&#10;Ou separados por vírgula:&#10;5511999999999, 5511888888888, 5511777777777"
                            rows="6"
                            onkeyup="processarNumerosManuais()"
                        ></textarea>
                        <div class="form-help">
                            💡 <strong>Formatos aceitos:</strong><br>
                            • Um número por linha<br>
                            • Separados por vírgula<br>
                            • Com ou sem código do país (55)<br>
                            • Exemplo: 11999999999 ou 5511999999999
                        </div>
                    </div>
                    
                    <div id="numeros-validados" class="numeros-container" style="display: none;">
                        <h4 class="form-label">✅ Números Validados</h4>
                        <div id="lista-numeros-validos" class="numeros-lista"></div>
                    </div>
                    
                    <div id="numeros-invalidos" class="numeros-container" style="display: none;">
                        <h4 class="form-label">❌ Números Inválidos</h4>
                        <div id="lista-numeros-invalidos" class="numeros-lista"></div>
                    </div>
                </div>
                
                <div class="form-group">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <span class="form-label">Contatos Disponíveis</span>
                        <div>
                            <button class="btn btn-secondary" onclick="selecionarTodos()" style="padding: 5px 10px; font-size: 0.8rem;">
                                ✅ Todos
                            </button>
                            <button class="btn btn-secondary" onclick="deselecionarTodos()" style="padding: 5px 10px; font-size: 0.8rem; margin-left: 5px;">
                                ❌ Nenhum
                            </button>
                        </div>
                    </div>
                    <div id="contatos-grid" class="contatos-grid">
                        <div style="text-align: center; padding: 40px; color: #666;">
                            <div class="spinner"></div>
                            <p>Carregando contatos...</p>
                        </div>
                    </div>
                </div>
                
                <div id="resultados-section" style="display: none;">
                    <h3 class="section-title">📊 Resultados do Disparo</h3>
                    <div id="resultados-stats" class="stats-container"></div>
                    <div id="resultados-detalhes" class="resultados-container"></div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let contatos = [];
        let contatosSelecionados = [];
        let contatosFiltrados = [];
        let modoAtual = 'contatos'; // 'contatos' ou 'numeros'
        let numerosManuaisValidos = [];
        let disparoAtivo = false;
        let intervaloPoll = null;
        let currentDispatchId = null;
        
        // Carregar contatos ao iniciar
        document.addEventListener('DOMContentLoaded', function() {
            carregarContatos();
            
            // Verificar se há disparo ativo ao carregar página
            verificarEstadoDisparo();
            
            // Configurar arquivo
            document.getElementById('arquivo').addEventListener('change', function(e) {
                const arquivo = e.target.files[0];
                const info = document.getElementById('arquivo-info');
                
                if (arquivo) {
                    info.innerHTML = \`📎 <strong>\${arquivo.name}</strong> (\${formatarTamanho(arquivo.size)})\`;
                    info.style.color = '#25D366';
                } else {
                    info.innerHTML = '';
                }
                atualizarPreview();
            });
            
            // Configurar listeners para preview
            document.getElementById('mensagem').addEventListener('input', atualizarPreview);
            document.getElementById('legenda').addEventListener('input', atualizarPreview);
            
            // Inicializar template
            alterarTemplate();
        });
        
        // Função para alternar entre templates
        function alterarTemplate() {
            const tipo = document.getElementById('tipoTemplate').value;
            const grupoMensagem = document.getElementById('grupo-mensagem');
            const grupoArquivo = document.getElementById('grupo-arquivo');
            const grupoGravador = document.getElementById('grupo-gravador');
            const grupoLegenda = document.getElementById('grupo-legenda');
            const labelArquivo = document.getElementById('label-arquivo');
            const fileLabelText = document.getElementById('file-label-text');
            const arquivo = document.getElementById('arquivo');
            
            // Reset
            grupoMensagem.style.display = 'block';
            grupoArquivo.style.display = 'none';
            grupoGravador.style.display = 'none';
            grupoLegenda.style.display = 'none';
            
            switch(tipo) {
                case 'texto':
                    // Apenas mensagem
                    break;
                    
                case 'imagem':
                    grupoMensagem.style.display = 'none';
                    grupoArquivo.style.display = 'block';
                    labelArquivo.textContent = '🖼️ Imagem';
                    fileLabelText.textContent = '🖼️ Selecionar imagem';
                    arquivo.accept = '.jpg,.jpeg,.png,.gif,.webp';
                    break;
                    
                case 'imagem-legenda':
                    grupoMensagem.style.display = 'none';
                    grupoArquivo.style.display = 'block';
                    grupoLegenda.style.display = 'block';
                    labelArquivo.textContent = '🖼️ Imagem';
                    fileLabelText.textContent = '🖼️ Selecionar imagem';
                    arquivo.accept = '.jpg,.jpeg,.png,.gif,.webp';
                    break;
                    
                case 'audio':
                    grupoMensagem.style.display = 'none';
                    grupoArquivo.style.display = 'block';
                    grupoGravador.style.display = 'block';
                    labelArquivo.textContent = '🎵 Áudio';
                    fileLabelText.textContent = '🎵 Selecionar áudio';
                    arquivo.accept = '.mp3,.wav,.ogg,.m4a';
                    break;
                    

                    
                case 'arquivo':
                    grupoMensagem.style.display = 'none';
                    grupoArquivo.style.display = 'block';
                    labelArquivo.textContent = '📎 Arquivo';
                    fileLabelText.textContent = '📎 Selecionar arquivo';
                    arquivo.accept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar';
                    break;
                    
                case 'arquivo-legenda':
                    grupoMensagem.style.display = 'none';
                    grupoArquivo.style.display = 'block';
                    grupoLegenda.style.display = 'block';
                    labelArquivo.textContent = '📎 Arquivo';
                    fileLabelText.textContent = '📎 Selecionar arquivo';
                    arquivo.accept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.rar';
                    break;
            }
            
            atualizarPreview();
        }
        
        // Função para atualizar preview
        function atualizarPreview() {
            const tipo = document.getElementById('tipoTemplate').value;
            const mensagem = document.getElementById('mensagem').value;
            const legenda = document.getElementById('legenda').value;
            const arquivo = document.getElementById('arquivo').files[0];
            const preview = document.getElementById('template-preview');
            const previewContent = document.getElementById('template-preview-content');
            
            let html = '';
            
            switch(tipo) {
                case 'texto':
                    if (mensagem.trim()) {
                        html = \`<div><strong>📝 Texto:</strong><br>\${mensagem.replace(/\\n/g, '<br>')}</div>\`;
                    }
                    break;
                    
                case 'imagem':
                    if (arquivo) {
                        html = \`<div><strong>🖼️ Imagem:</strong> \${arquivo.name}</div>\`;
                    }
                    break;
                    
                case 'imagem-legenda':
                    if (arquivo) {
                        html = \`<div><strong>🖼️ Imagem:</strong> \${arquivo.name}</div>\`;
                        if (legenda.trim()) {
                            html += \`<div style="margin-top: 8px;"><strong>📝 Legenda:</strong><br>\${legenda.replace(/\\n/g, '<br>')}</div>\`;
                        }
                    }
                    break;
                    
                case 'audio':
                    if (arquivo) {
                        html = \`<div><strong>🎵 Áudio:</strong> \${arquivo.name}</div>\`;
                    }
                    break;
                    

                    
                case 'arquivo':
                    if (arquivo) {
                        html = \`<div><strong>📎 Arquivo:</strong> \${arquivo.name}</div>\`;
                    }
                    break;
                    
                case 'arquivo-legenda':
                    if (arquivo) {
                        html = \`<div><strong>📎 Arquivo:</strong> \${arquivo.name}</div>\`;
                        if (legenda.trim()) {
                            html += \`<div style="margin-top: 8px;"><strong>📝 Legenda:</strong><br>\${legenda.replace(/\\n/g, '<br>')}</div>\`;
                        }
                    }
                    break;
            }
            
            if (html) {
                previewContent.innerHTML = html;
                preview.style.display = 'block';
            } else {
                preview.style.display = 'none';
            }
        }
        
        // Função para alternar modo de seleção
        function alternarModo(modo) {
            modoAtual = modo;
            
            // Atualizar tabs
            document.getElementById('tab-contatos').classList.toggle('active', modo === 'contatos');
            document.getElementById('tab-numeros').classList.toggle('active', modo === 'numeros');
            
            // Mostrar/ocultar painéis
            document.getElementById('modo-contatos').style.display = modo === 'contatos' ? 'block' : 'none';
            document.getElementById('modo-numeros').style.display = modo === 'numeros' ? 'block' : 'none';
            
            // Atualizar estatísticas
            atualizarEstatisticas();
        }
        
        // Função para corrigir número baseado no DDD
        function corrigirNumeroPorDDD(numeroLimpo) {
            // DDDs da região metropolitana de São Paulo que usam 9 dígitos
            const dddsComNove = ['11', '12', '13', '14', '15', '16', '17', '18', '19'];
            
            let numeroCorrigido = numeroLimpo;
            
            // Se o número tem 11 dígitos (DDD + 9 dígitos)
            if (numeroLimpo.length === 11) {
                const ddd = numeroLimpo.substring(0, 2);
                
                // Se o DDD NÃO está na lista dos que usam 9 dígitos
                if (!dddsComNove.includes(ddd)) {
                    // Remove o 9º dígito (que seria o terceiro dígito do número, após o DDD)
                    // Formato: DDD + 9 + 8 dígitos -> DDD + 8 dígitos
                    const dddParte = numeroLimpo.substring(0, 2); // DDD
                    const primeiroDígito = numeroLimpo.substring(2, 3); // Primeiro dígito após DDD
                    const restoNumero = numeroLimpo.substring(3); // Resto do número
                    
                    // Se o primeiro dígito após o DDD é 9, remove ele
                    if (primeiroDígito === '9' && restoNumero.length === 8) {
                        numeroCorrigido = dddParte + restoNumero;
                        console.log(\`🔧 Corrigido número para DDD \${ddd}: \${numeroLimpo} → \${numeroCorrigido}\`);
                    }
                }
            }
            
            // Se o número tem 13 dígitos (55 + DDD + 9 dígitos)
            if (numeroLimpo.length === 13 && numeroLimpo.startsWith('55')) {
                const ddd = numeroLimpo.substring(2, 4);
                
                // Se o DDD NÃO está na lista dos que usam 9 dígitos
                if (!dddsComNove.includes(ddd)) {
                    // Remove o 9º dígito
                    const codigoPais = numeroLimpo.substring(0, 2); // 55
                    const dddParte = numeroLimpo.substring(2, 4); // DDD
                    const primeiroDígito = numeroLimpo.substring(4, 5); // Primeiro dígito após DDD
                    const restoNumero = numeroLimpo.substring(5); // Resto do número
                    
                    // Se o primeiro dígito após o DDD é 9, remove ele
                    if (primeiroDígito === '9' && restoNumero.length === 8) {
                        numeroCorrigido = codigoPais + dddParte + restoNumero;
                        console.log(\`🔧 Corrigido número para DDD \${ddd}: \${numeroLimpo} → \${numeroCorrigido}\`);
                    }
                }
            }
            
            return numeroCorrigido;
        }
        
        // Função para processar números manuais
        function processarNumerosManuais() {
            const texto = document.getElementById('numerosManuais').value;
            const numerosValidados = document.getElementById('numeros-validados');
            const numerosInvalidos = document.getElementById('numeros-invalidos');
            const listaValidos = document.getElementById('lista-numeros-validos');
            const listaInvalidos = document.getElementById('lista-numeros-invalidos');
            
            if (!texto.trim()) {
                numerosValidados.style.display = 'none';
                numerosInvalidos.style.display = 'none';
                numerosManuaisValidos = [];
                atualizarEstatisticas();
                return;
            }
            
            // Extrair números (por linha ou vírgula)
            const numeros = texto.split(/[\\n,]/)
                .map(n => n.trim())
                .filter(n => n.length > 0);
            
            const validos = [];
            const invalidos = [];
            
            numeros.forEach(numero => {
                const numeroLimpo = numero.replace(/\\D/g, ''); // Remove tudo que não é dígito
                
                // Aplicar correção do DDD
                const numeroCorrigido = corrigirNumeroPorDDD(numeroLimpo);
                
                // Validar formato brasileiro
                if (numeroCorrigido.length === 11) {
                    // Número com DDD (11 dígitos) - adicionar código do país
                    validos.push('55' + numeroCorrigido);
                } else if (numeroCorrigido.length === 10) {
                    // Número com DDD sem 9 (10 dígitos) - adicionar código do país
                    validos.push('55' + numeroCorrigido);
                } else if (numeroCorrigido.length === 13 && numeroCorrigido.startsWith('55')) {
                    // Número com código do país (13 dígitos)
                    validos.push(numeroCorrigido);
                } else if (numeroCorrigido.length === 12 && numeroCorrigido.startsWith('55')) {
                    // Número com código do país sem 9 (12 dígitos)
                    validos.push(numeroCorrigido);
                } else if (numeroCorrigido.length >= 10 && numeroCorrigido.length <= 11) {
                    // Tentar adicionar código do país
                    const numeroComCodigo = '55' + numeroCorrigido;
                    if (numeroComCodigo.length >= 12 && numeroComCodigo.length <= 13) {
                        validos.push(numeroComCodigo);
                    } else {
                        invalidos.push(numero);
                    }
                } else {
                    invalidos.push(numero);
                }
            });
            
            // Remover duplicatas
            numerosManuaisValidos = [...new Set(validos)];
            const numerosInvalidosUnicos = [...new Set(invalidos)];
            
            // Exibir números válidos
            if (numerosManuaisValidos.length > 0) {
                listaValidos.innerHTML = numerosManuaisValidos.map(num => 
                    \`<span class="numero-chip numero-valido">📱 \${num}</span>\`
                ).join('');
                numerosValidados.style.display = 'block';
            } else {
                numerosValidados.style.display = 'none';
            }
            
            // Exibir números inválidos
            if (numerosInvalidosUnicos.length > 0) {
                listaInvalidos.innerHTML = numerosInvalidosUnicos.map(num => 
                    \`<span class="numero-chip numero-invalido">❌ \${num}</span>\`
                ).join('');
                numerosInvalidos.style.display = 'block';
            } else {
                numerosInvalidos.style.display = 'none';
            }
            
            atualizarEstatisticas();
        }
        
        async function carregarContatos() {
            try {
                console.log('🔄 Iniciando carregamento de contatos...');
                const response = await fetch('/api/disparo/contatos');
                console.log('📡 Resposta da API recebida:', response.status);
                const data = await response.json();
                console.log('📋 Dados recebidos:', data);
                
                if (data.success) {
                    contatos = data.contatos;
                    contatosFiltrados = [...contatos];
                    console.log('✅ Contatos carregados:', contatos.length);
                    renderizarContatos();
                    atualizarEstatisticas();
                } else {
                    console.error('❌ Erro na resposta da API:', data.message);
                    mostrarAlerta('error', data.message || 'Erro ao carregar contatos');
                }
            } catch (error) {
                console.error('❌ Erro ao carregar contatos:', error);
                mostrarAlerta('error', 'Erro ao carregar contatos: ' + error.message);
            }
        }
        
        function renderizarContatos() {
            console.log('🎨 Iniciando renderização de contatos...');
            const grid = document.getElementById('contatos-grid');
            
            if (!grid) {
                console.error('❌ Elemento contatos-grid não encontrado!');
                return;
            }
            
            console.log('📊 Contatos filtrados para renderizar:', contatosFiltrados.length);
            
            if (contatosFiltrados.length === 0) {
                console.log('⚠️ Nenhum contato para exibir');
                grid.innerHTML = \`
                    <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #666;">
                        <p>Nenhum contato encontrado</p>
                    </div>
                \`;
                return;
            }
            
            console.log('🏗️ Gerando HTML para contatos...');
            try {
            grid.innerHTML = contatosFiltrados.map(contato => \`
                <div class="contato-card \${contatosSelecionados.includes(contato.phoneNumber) ? 'selected' : ''}" 
                     onclick="toggleContato('\${contato.phoneNumber}')">
                    <div class="contato-nome">\${contato.name || 'Sem nome'}</div>
                    <div class="contato-telefone">\${contato.phoneNumber}</div>
                    <div class="contato-badges">
                        \${contato.crmData?.status ? \`<span class="badge badge-status">\${getStatusLabel(contato.crmData.status)}</span>\` : ''}
                        \${contato.crmData?.priority ? \`<span class="badge badge-priority">\${getPriorityLabel(contato.crmData.priority)}</span>\` : ''}
                    </div>
                </div>
            \`).join('');
                console.log('✅ Contatos renderizados com sucesso!');
            } catch (error) {
                console.error('❌ Erro ao renderizar contatos:', error);
            }
        }
        
        function toggleContato(phoneNumber) {
            const index = contatosSelecionados.indexOf(phoneNumber);
            
            if (index > -1) {
                contatosSelecionados.splice(index, 1);
            } else {
                contatosSelecionados.push(phoneNumber);
            }
            
            renderizarContatos();
            atualizarEstatisticas();
        }
        
        function selecionarTodos() {
            contatosSelecionados = contatosFiltrados.map(c => c.phoneNumber);
            renderizarContatos();
            atualizarEstatisticas();
        }
        
        function deselecionarTodos() {
            contatosSelecionados = [];
            renderizarContatos();
            atualizarEstatisticas();
        }
        
        function limparSelecao() {
            deselecionarTodos();
            document.getElementById('tipoTemplate').value = 'texto';
            document.getElementById('mensagem').value = '';
            document.getElementById('legenda').value = '';
            document.getElementById('arquivo').value = '';
            document.getElementById('arquivo-info').innerHTML = '';
            document.getElementById('numerosManuais').value = '';
            document.getElementById('agendarPara').value = '';
            document.getElementById('intervalo').value = '3';
            
            // Limpar números manuais
            numerosManuaisValidos = [];
            document.getElementById('numeros-validados').style.display = 'none';
            document.getElementById('numeros-invalidos').style.display = 'none';
            
            // Limpar template selecionado
            document.getElementById('templatesSalvos').value = '';
            document.getElementById('template-info').style.display = 'none';
            document.getElementById('template-actions').style.display = 'none';
            window.templateComArquivo = null;
            
            // Resetar template
            alterarTemplate();
            atualizarEstatisticas();
        }
        
        function filtrarContatos() {
            const busca = document.getElementById('buscarContato').value.toLowerCase();
            const status = document.getElementById('filtroStatus').value;
            
            contatosFiltrados = contatos.filter(contato => {
                const matchBusca = !busca || 
                    (contato.name && contato.name.toLowerCase().includes(busca)) ||
                    contato.phoneNumber.includes(busca);
                
                const matchStatus = !status || 
                    (contato.crmData && contato.crmData.status === status);
                
                return matchBusca && matchStatus;
            });
            
            renderizarContatos();
            atualizarEstatisticas();
        }
        
        function atualizarEstatisticas() {
            if (modoAtual === 'contatos') {
                document.getElementById('totalContatos').textContent = contatosFiltrados.length;
                document.getElementById('contatosSelecionados').textContent = contatosSelecionados.length;
            } else {
                document.getElementById('totalContatos').textContent = numerosManuaisValidos.length;
                document.getElementById('contatosSelecionados').textContent = numerosManuaisValidos.length;
            }
        }
        
        async function enviarDisparo() {
            const tipoTemplate = document.getElementById('tipoTemplate').value;
            const mensagem = document.getElementById('mensagem').value.trim();
            const legenda = document.getElementById('legenda').value.trim();
            const arquivo = document.getElementById('arquivo').files[0];
            const agendarPara = document.getElementById('agendarPara').value;
            const intervalo = document.getElementById('intervalo').value;
            
            console.log('🔍 Debug enviarDisparo:', {
                tipoTemplate,
                mensagem: mensagem ? 'presente' : 'ausente',
                legenda: legenda ? 'presente' : 'ausente', 
                arquivo: arquivo ? arquivo.name : 'nenhum',
                templateComArquivo: window.templateComArquivo ? window.templateComArquivo.nome : 'nenhum',
                agendarPara,
                intervalo
            });
            
            // Validações baseadas no template
            if (tipoTemplate === 'texto' && !mensagem) {
                mostrarAlerta('error', 'Por favor, digite uma mensagem');
                return;
            }
            
            if (['imagem', 'imagem-legenda', 'audio', 'arquivo', 'arquivo-legenda'].includes(tipoTemplate) && !arquivo && !window.templateComArquivo) {
                mostrarAlerta('error', 'Por favor, selecione um arquivo');
                return;
            }
            
            // Validar contatos selecionados baseado no modo
            let totalContatos = 0;
            if (modoAtual === 'contatos') {
                totalContatos = contatosSelecionados.length;
            } else {
                totalContatos = numerosManuaisValidos.length;
            }
            
            if (totalContatos === 0) {
                mostrarAlerta('error', 'Por favor, selecione pelo menos um contato ou digite números válidos');
                return;
            }
            
            if (agendarPara) {
                const agendamento = new Date(agendarPara);
                const agora = new Date();
                
                if (agendamento <= agora) {
                    mostrarAlerta('error', 'A data de agendamento deve ser futura');
                    return;
                }
            }
            
            // Confirmar envio
            const confirmacao = confirm(\`Confirma o envio da mensagem para \${totalContatos} contato(s)?\`);
            if (!confirmacao) return;
            
            // Mostrar loading
            document.getElementById('loading').style.display = 'block';
            document.getElementById('resultados-section').style.display = 'none';
            
            try {
                // Upload do arquivo se existir, ou usar arquivo do template
                let arquivoPath = null;
                if (arquivo) {
                    console.log('📎 Fazendo upload do arquivo:', arquivo.name);
                    const formData = new FormData();
                    formData.append('file', arquivo);
                    
                    const uploadResponse = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const uploadData = await uploadResponse.json();
                    console.log('📋 Resposta do upload:', uploadData);
                    
                    if (uploadData.success) {
                        arquivoPath = uploadData.file.url; // Corrigido: era uploadData.filePath
                        console.log('✅ Arquivo uploaded, path:', arquivoPath);
                    } else {
                        throw new Error('Erro no upload do arquivo: ' + uploadData.message);
                    }
                } else if (window.templateComArquivo) {
                    // Usar arquivo do template
                    arquivoPath = window.templateComArquivo.url;
                    console.log('📋 Usando arquivo do template:', window.templateComArquivo.nome);
                }
                
                // Preparar dados dos contatos baseado no modo
                let contatosParaEnvio = [];
                
                if (modoAtual === 'contatos') {
                    // Contatos da lista
                    contatosParaEnvio = contatos.filter(c => 
                        contatosSelecionados.includes(c.phoneNumber)
                    );
                } else {
                    // Números manuais
                    contatosParaEnvio = numerosManuaisValidos.map(numero => ({
                        phoneNumber: numero,
                        name: 'Contato Manual'
                    }));
                }
                
                // Preparar mensagem baseada no template
                let mensagemFinal = '';
                if (tipoTemplate === 'texto') {
                    mensagemFinal = mensagem;
                    console.log('📝 Usando mensagem para texto:', mensagemFinal);
                } else if (['imagem-legenda', 'arquivo-legenda'].includes(tipoTemplate)) {
                    mensagemFinal = legenda;
                    console.log('📝 Usando legenda para mídia:', mensagemFinal);
                }
                
                console.log('📋 Dados finais para envio:', {
                    tipoTemplate,
                    mensagemFinal,
                    arquivoPath,
                    totalContatos: contatosParaEnvio.length
                });
                
                // Enviar disparo
                const response = await fetch('/api/disparo/enviar', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contatos: contatosParaEnvio,
                        mensagem: mensagemFinal,
                        arquivo: arquivoPath,
                        tipoTemplate,
                        agendarPara,
                        intervalo
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    if (data.agendado) {
                        mostrarAlerta('success', data.message);
                    } else {
                        // Iniciar monitoramento para disparo imediato
                        currentDispatchId = Date.now().toString();
                        disparoAtivo = true;
                        iniciarMonitoramento();
                        
                        mostrarAlerta('success', 'Disparo iniciado! Validando números...');
                        
                        // Verificar se há números inválidos
                        if (data.invalidNumbers && data.invalidNumbers.length > 0) {
                            document.getElementById('numeros-invalidos-section').style.display = 'block';
                            const lista = document.getElementById('numeros-invalidos-list');
                            lista.innerHTML = data.invalidNumbers.map(num => \`
                                <div class="invalid-number-item">
                                    <div class="invalid-number-info">
                                        <div class="invalid-number-name">\${num.name}</div>
                                        <div class="invalid-number-phone">\${num.phoneNumber}</div>
                                        <div class="invalid-number-error">\${num.error}</div>
                                    </div>
                                </div>
                            \`).join('');
                        }
                        
                        // Mostrar resultados se disparo foi interrompido
                        if (data.interrupted) {
                            mostrarAlerta('warning', 'Disparo foi interrompido');
                            finalizarMonitoramento();
                        }
                        
                        mostrarResultados(data.resultados);
                    }
                } else {
                    mostrarAlerta('error', data.message || 'Erro no disparo');
                }
                
            } catch (error) {
                console.error('Erro no disparo:', error);
                mostrarAlerta('error', 'Erro ao enviar disparo: ' + error.message);
            } finally {
                document.getElementById('loading').style.display = 'none';
            }
        }
        
        function mostrarResultados(resultados) {
            const section = document.getElementById('resultados-section');
            const stats = document.getElementById('resultados-stats');
            const detalhes = document.getElementById('resultados-detalhes');
            
            // Estatísticas
            stats.innerHTML = \`
                <div class="stat-card">
                    <div class="stat-number">\${resultados.total}</div>
                    <div class="stat-label">Total</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color: #25D366;">\${resultados.enviados}</div>
                    <div class="stat-label">Enviados</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color: #dc3545;">\${resultados.falharam}</div>
                    <div class="stat-label">Falharam</div>
                </div>
            \`;
            
            // Detalhes
            detalhes.innerHTML = resultados.detalhes.map(item => \`
                <div class="resultado-item \${item.status === 'sucesso' ? 'resultado-sucesso' : 'resultado-erro'}">
                    <div>
                        <span class="status-icon \${item.status === 'sucesso' ? 'status-sucesso' : 'status-erro'}"></span>
                        <strong>\${item.contato}</strong> (\${item.phoneNumber})
                        \${item.erro ? \`<br><small style="color: #dc3545;">\${item.erro}</small>\` : ''}
                    </div>
                    <small>\${item.horario}</small>
                </div>
            \`).join('');
            
            section.style.display = 'block';
        }
        
        function mostrarAlerta(tipo, mensagem) {
            const alertas = document.getElementById('alertas');
            const classe = tipo === 'success' ? 'alert-success' : 
                          tipo === 'warning' ? 'alert-warning' : 'alert-error';
            
            const alerta = document.createElement('div');
            alerta.className = \`alert \${classe}\`;
            alerta.innerHTML = mensagem;
            
            alertas.appendChild(alerta);
            
            setTimeout(() => {
                alerta.remove();
            }, 5000);
        }

        // ========== FUNÇÕES DE CONTROLE DO DISPARO ==========
        
        // Função para verificar estado do disparo
        async function verificarEstadoDisparo() {
            try {
                const response = await fetch('/api/disparo/status');
                const data = await response.json();
                
                if (data.success && data.isActive) {
                    currentDispatchId = data.currentDispatchId;
                    disparoAtivo = true;
                    
                    // Restaurar estado salvo do localStorage
                    const estadoSalvo = localStorage.getItem('disparo-estado');
                    if (estadoSalvo) {
                        const estado = JSON.parse(estadoSalvo);
                        if (estado.currentDispatchId === currentDispatchId) {
                            mostrarAlerta('warning', 'Disparo em andamento detectado. Continuando monitoramento...');
                            iniciarMonitoramento();
                        }
                    }
                } else {
                    // Limpar estado se não há disparo ativo
                    localStorage.removeItem('disparo-estado');
                    resetarInterfaceDisparo();
                }
            } catch (error) {
                console.error('Erro ao verificar estado do disparo:', error);
            }
        }

        // Função para iniciar monitoramento do progresso
        function iniciarMonitoramento() {
            if (intervaloPoll) {
                clearInterval(intervaloPoll);
            }
            
            // Configurar interface para disparo ativo
            document.getElementById('btn-enviar-disparo').style.display = 'none';
            document.getElementById('btn-parar-disparo').style.display = 'inline-flex';
            document.getElementById('loading').style.display = 'block';
            
            // Salvar estado no localStorage
            const estado = {
                currentDispatchId,
                disparoAtivo: true,
                timestamp: Date.now()
            };
            localStorage.setItem('disparo-estado', JSON.stringify(estado));
            
            // Iniciar polling do progresso
            intervaloPoll = setInterval(async () => {
                try {
                    const response = await fetch('/api/disparo/status');
                    const data = await response.json();
                    
                    if (data.success) {
                        atualizarProgresso(data.progress);
                        
                        if (!data.isActive) {
                            // Disparo finalizado
                            finalizarMonitoramento();
                        }
                    }
                } catch (error) {
                    console.error('Erro ao buscar progresso:', error);
                }
            }, 2000); // Verificar a cada 2 segundos
        }

        // Função para atualizar progresso na interface
        function atualizarProgresso(progress) {
            // Atualizar progresso de validação
            if (progress.validationPhase) {
                document.getElementById('validacao-progress').style.display = 'block';
                const porcentagem = progress.total > 0 ? (progress.validated / progress.total) * 100 : 0;
                document.getElementById('validacao-progress-fill').style.width = porcentagem + '%';
                document.getElementById('validacao-progress-text').textContent = \`\${progress.validated} / \${progress.total} validados\`;
            } else {
                document.getElementById('validacao-progress').style.display = 'none';
            }
            
            // Atualizar progresso de envio
            if (progress.sendingPhase) {
                document.getElementById('envio-progress').style.display = 'block';
                const porcentagem = progress.total > 0 ? (progress.sent / progress.total) * 100 : 0;
                document.getElementById('envio-progress-fill').style.width = porcentagem + '%';
                document.getElementById('envio-progress-text').textContent = \`\${progress.sent} / \${progress.total} enviados\`;
            } else {
                document.getElementById('envio-progress').style.display = 'none';
            }
            
            // Exibir números inválidos
            if (progress.invalidNumbers && progress.invalidNumbers.length > 0) {
                document.getElementById('numeros-invalidos-section').style.display = 'block';
                const lista = document.getElementById('numeros-invalidos-list');
                lista.innerHTML = progress.invalidNumbers.map(num => \`
                    <div class="invalid-number-item">
                        <div class="invalid-number-info">
                            <div class="invalid-number-name">\${num.name}</div>
                            <div class="invalid-number-phone">\${num.phoneNumber}</div>
                            <div class="invalid-number-error">\${num.error}</div>
                        </div>
                    </div>
                \`).join('');
            }
        }

        // Função para parar o disparo
        async function pararDisparo() {
            if (!confirm('Tem certeza que deseja parar o disparo?')) {
                return;
            }
            
            try {
                const response = await fetch('/api/disparo/parar', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    mostrarAlerta('warning', 'Comando de parada enviado. Aguarde...');
                    document.getElementById('btn-parar-disparo').disabled = true;
                    document.getElementById('btn-parar-disparo').innerHTML = '⏳ Parando...';
                } else {
                    mostrarAlerta('error', data.message || 'Erro ao parar disparo');
                }
            } catch (error) {
                console.error('Erro ao parar disparo:', error);
                mostrarAlerta('error', 'Erro ao parar disparo: ' + error.message);
            }
        }

        // Função para finalizar monitoramento
        function finalizarMonitoramento() {
            if (intervaloPoll) {
                clearInterval(intervaloPoll);
                intervaloPoll = null;
            }
            
            // Limpar estado do localStorage
            localStorage.removeItem('disparo-estado');
            
            // Resetar interface
            resetarInterfaceDisparo();
            
            mostrarAlerta('success', 'Disparo finalizado!');
        }

        // Função para resetar interface do disparo
        function resetarInterfaceDisparo() {
            disparoAtivo = false;
            currentDispatchId = null;
            
            document.getElementById('btn-enviar-disparo').style.display = 'inline-flex';
            document.getElementById('btn-parar-disparo').style.display = 'none';
            document.getElementById('btn-parar-disparo').disabled = false;
            document.getElementById('btn-parar-disparo').innerHTML = '⏹️ Parar Disparo';
            document.getElementById('loading').style.display = 'none';
            
            // Esconder seções de progresso
            document.getElementById('validacao-progress').style.display = 'none';
            document.getElementById('envio-progress').style.display = 'none';
            document.getElementById('numeros-invalidos-section').style.display = 'none';
        }

        // ========== FUNÇÕES DO GRAVADOR DE ÁUDIO ==========
        let mediaRecorder = null;
        let audioChunks = [];
        let recordingStartTime = null;
        let audioBlob = null;
        let isRecording = false;

        async function iniciarGravacao() {
            if (isRecording) {
                pararGravacao();
                return;
            }

            try {
                console.log('🎙️ Solicitando permissão para microfone...');
                
                const stream = await navigator.mediaDevices.getUserMedia({ 
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 44100,
                        channelCount: 1
                    }
                });
                
                // Usar formato mais compatível
                let mimeType = 'audio/webm;codecs=opus';
                if (MediaRecorder.isTypeSupported('audio/webm')) {
                    mimeType = 'audio/webm';
                    console.log('🎵 Usando formato WebM para gravação');
                }
                
                mediaRecorder = new MediaRecorder(stream, { 
                    mimeType,
                    audioBitsPerSecond: 128000
                });
                
                audioChunks = [];
                recordingStartTime = Date.now();
                isRecording = true;
                
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        audioChunks.push(event.data);
                    }
                };
                
                mediaRecorder.onstop = async () => {
                    console.log('🎙️ Gravação finalizada');
                    isRecording = false;
                    
                    // Criar blob com formato WebM
                    audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    
                    // Criar URL para preview
                    const audioUrl = URL.createObjectURL(audioBlob);
                    const audioPreview = document.getElementById('audio-preview');
                    audioPreview.src = audioUrl;
                    audioPreview.style.display = 'block';
                    
                    console.log('🎵 Áudio WebM criado:', {
                        tamanho: formatFileSize(audioBlob.size),
                        tipo: 'audio/webm'
                    });
                    
                    // Converter para formato otimizado para WhatsApp (MP3-compatível)
                    try {
                        console.log('🔄 Convertendo para formato otimizado...');
                        const optimizedBlob = await convertWebMToOptimized(audioBlob);
                        
                        if (optimizedBlob) {
                            audioBlob = optimizedBlob;
                            console.log('✅ Conversão para formato otimizado concluída:', formatFileSize(optimizedBlob.size));
                        }
                    } catch (conversionError) {
                        console.log('⚠️ Falha na conversão, usando WebM original:', conversionError.message);
                    }
                    
                    // Fazer upload automático
                    await uploadAudioGravado();
                    
                    // Parar todas as tracks do stream
                    stream.getTracks().forEach(track => track.stop());
                };
                
                mediaRecorder.start(1000); // Coletar dados a cada segundo
                
                // Atualizar interface
                atualizarInterfaceGravacao('gravando');
                
                console.log('🎙️ Gravação iniciada com qualidade otimizada');
                
            } catch (error) {
                console.error('❌ Erro ao iniciar gravação:', error);
                isRecording = false;
                
                if (error.name === 'NotAllowedError') {
                    mostrarAlerta('error', '🎙️ Permissão negada para usar o microfone. Permita o acesso e tente novamente.');
                } else if (error.name === 'NotFoundError') {
                    mostrarAlerta('error', '🎙️ Nenhum microfone encontrado. Conecte um microfone e tente novamente.');
                } else {
                    mostrarAlerta('error', '🎙️ Erro ao acessar o microfone: ' + error.message);
                }
                
                atualizarInterfaceGravacao('pronto');
            }
        }

        function pararGravacao() {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
                isRecording = false;
                
                // Atualizar interface
                atualizarInterfaceGravacao('parado');
                
                console.log('🎙️ Parando gravação...');
            }
        }

        // Função para converter WebM para formato otimizado (WAV que será convertido para MP3 no servidor)
        async function convertWebMToOptimized(webmBlob) {
            try {
                const arrayBuffer = await webmBlob.arrayBuffer();
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                
                // Decodificar o áudio WebM
                const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                
                // Converter para WAV otimizado (mono, 44.1kHz)
                const optimizedBuffer = audioBufferToOptimizedWav(audioBuffer);
                return new Blob([optimizedBuffer], { type: 'audio/wav' });
                
            } catch (error) {
                console.error('❌ Erro na conversão WebM->Otimizado:', error);
                throw error;
            }
        }

        // Função para converter AudioBuffer para WAV otimizado (mono, 44.1kHz)
        function audioBufferToOptimizedWav(buffer) {
            // Converter para mono se necessário
            const channels = 1; // Força mono para melhor compatibilidade com PTT
            const sampleRate = 44100; // Taxa padrão para melhor qualidade
            const length = Math.floor(buffer.length * (sampleRate / buffer.sampleRate));
            
            // Criar buffer WAV otimizado
            const arrayBuffer = new ArrayBuffer(44 + length * channels * 2);
            const view = new DataView(arrayBuffer);
            
            // Escrever header WAV
            const writeString = (offset, string) => {
                for (let i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            };
            
            writeString(0, 'RIFF');
            view.setUint32(4, 36 + length * channels * 2, true);
            writeString(8, 'WAVE');
            writeString(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true); // PCM
            view.setUint16(22, channels, true); // Mono
            view.setUint32(24, sampleRate, true); // 44.1kHz
            view.setUint32(28, sampleRate * channels * 2, true);
            view.setUint16(32, channels * 2, true);
            view.setUint16(34, 16, true); // 16-bit
            writeString(36, 'data');
            view.setUint32(40, length * channels * 2, true);
            
            // Converter para mono e resample se necessário
            const leftChannel = buffer.getChannelData(0);
            const rightChannel = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : leftChannel;
            
            let offset = 44;
            for (let i = 0; i < length; i++) {
                // Calcular índice no buffer original
                const originalIndex = Math.floor(i * (buffer.length / length));
                
                // Converter para mono (média dos canais)
                const leftSample = leftChannel[originalIndex] || 0;
                const rightSample = rightChannel[originalIndex] || 0;
                const monoSample = (leftSample + rightSample) / 2;
                
                // Converter para 16-bit
                const intSample = Math.max(-1, Math.min(1, monoSample));
                view.setInt16(offset, intSample * 0x7FFF, true);
                offset += 2;
            }
            
            console.log('🎵 Áudio otimizado:', {
                canais: channels,
                sampleRate: sampleRate + 'Hz',
                duracao: Math.round(length / sampleRate) + 's',
                tamanho: Math.round(arrayBuffer.byteLength / 1024) + 'KB'
            });
            
            return arrayBuffer;
        }

        function reproduzirGravacao() {
            const audioPreview = document.getElementById('audio-preview');
            if (audioPreview.src) {
                audioPreview.play();
            }
        }

        function limparGravacao() {
            // Limpar dados
            audioBlob = null;
            audioChunks = [];
            
            // Limpar interface
            const audioPreview = document.getElementById('audio-preview');
            audioPreview.src = '';
            audioPreview.style.display = 'none';
            
            // Limpar arquivo selecionado
            const arquivo = document.getElementById('arquivo');
            arquivo.value = '';
            
            // Resetar interface
            atualizarInterfaceGravacao('pronto');
            
            console.log('🗑️ Gravação limpa');
        }

        function atualizarInterfaceGravacao(estado) {
            const btnGravar = document.getElementById('btn-gravar');
            const btnParar = document.getElementById('btn-parar');
            const btnReproduzir = document.getElementById('btn-reproduzir');
            const btnLimpar = document.getElementById('btn-limpar-audio');
            const statusGravacao = document.getElementById('status-gravacao');
            
            switch (estado) {
                case 'gravando':
                    btnGravar.disabled = true;
                    btnParar.disabled = false;
                    btnReproduzir.disabled = true;
                    btnLimpar.disabled = true;
                    statusGravacao.textContent = '🔴 Gravando...';
                    statusGravacao.classList.add('recording-pulse');
                    break;
                    
                case 'parado':
                    btnGravar.disabled = false;
                    btnParar.disabled = true;
                    btnReproduzir.disabled = false;
                    btnLimpar.disabled = false;
                    statusGravacao.textContent = '✅ Gravação concluída';
                    statusGravacao.classList.remove('recording-pulse');
                    break;
                    
                case 'pronto':
                    btnGravar.disabled = false;
                    btnParar.disabled = true;
                    btnReproduzir.disabled = true;
                    btnLimpar.disabled = true;
                    statusGravacao.textContent = 'Pronto para gravar';
                    statusGravacao.classList.remove('recording-pulse');
                    break;
            }
        }

        async function uploadAudioGravado() {
            if (!audioBlob) return;
            
            try {
                console.log('📤 Preparando áudio gravado para envio...');
                
                // Determinar formato e nome do arquivo
                let fileName, mimeType, formatDescription;
                
                if (audioBlob.type.includes('wav')) {
                    fileName = \`gravacao_\${Date.now()}.wav\`;
                    mimeType = 'audio/wav';
                    formatDescription = 'WAV (alta compatibilidade)';
                    console.log('🎵 Usando áudio convertido para WAV');
                } else {
                    fileName = \`gravacao_\${Date.now()}.webm\`;
                    mimeType = 'audio/webm';
                    formatDescription = 'WebM (formato original)';
                    console.log('🎵 Usando áudio WebM original');
                }
                
                const file = new File([audioBlob], fileName, { type: mimeType });
                
                // Simular seleção do arquivo
                const arquivo = document.getElementById('arquivo');
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                arquivo.files = dataTransfer.files;
                
                // Mostrar info do arquivo
                const arquivoInfo = document.getElementById('arquivo-info');
                arquivoInfo.innerHTML = \`
                    <div style="color: #25D366; font-weight: 500;">
                        🎙️ Áudio gravado: \${file.name} (\${formatFileSize(file.size)})
                        <br><small>Formato: \${formatDescription}</small>
                    </div>
                \`;
                
                console.log('✅ Áudio preparado para envio:', {
                    nome: file.name,
                    tamanho: formatFileSize(file.size),
                    tipo: mimeType
                });
                
                // Atualizar preview se necessário
                atualizarPreview();
                
            } catch (error) {
                console.error('❌ Erro ao preparar áudio:', error);
                mostrarAlerta('error', 'Erro ao processar áudio gravado: ' + error.message);
            }
        }

        // Função para converter áudio para MP3 usando lamejs
        async function convertToMp3(audioBlob) {
            return new Promise(async (resolve, reject) => {
                try {
                    // Criar contexto de áudio
                    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    
                    // Converter blob para array buffer
                    const arrayBuffer = await audioBlob.arrayBuffer();
                    
                    // Decodificar áudio
                    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                    
                    // Obter dados PCM
                    const samples = audioBuffer.getChannelData(0);
                    const sampleRate = audioBuffer.sampleRate;
                    
                    // Converter para formato que simula MP3 (na verdade é WAV com header MP3)
                    const mp3Data = encodeWAVasMP3(samples, sampleRate);
                    
                    resolve(new Blob([mp3Data], { type: 'audio/mpeg' }));
                    
                } catch (error) {
                    console.error('❌ Erro na conversão de áudio:', error);
                    reject(error);
                }
            });
        }

        // Função simplificada para criar um "MP3" (na verdade WAV com extensão MP3)
        function encodeWAVasMP3(samples, sampleRate) {
            const length = samples.length;
            const buffer = new ArrayBuffer(44 + length * 2);
            const view = new DataView(buffer);
            
            // WAV header
            const writeString = (offset, string) => {
                for (let i = 0; i < string.length; i++) {
                    view.setUint8(offset + i, string.charCodeAt(i));
                }
            };
            
            writeString(0, 'RIFF');
            view.setUint32(4, 36 + length * 2, true);
            writeString(8, 'WAVE');
            writeString(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            writeString(36, 'data');
            view.setUint32(40, length * 2, true);
            
            // Convert samples to 16-bit PCM
            let offset = 44;
            for (let i = 0; i < length; i++) {
                const sample = Math.max(-1, Math.min(1, samples[i]));
                view.setInt16(offset, sample * 0x7FFF, true);
                offset += 2;
            }
            
            return buffer;
        }

        function formatFileSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function formatarTamanho(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function getStatusLabel(status) {
            const labels = {
                'novo': 'Novo',
                'andamento': 'Em Andamento', 
                'aprovado': 'Aprovado',
                'reprovado': 'Reprovado',
                'client': 'Cliente',
                'inactive': 'Inativo',
                'blocked': 'Bloqueado'
            };
            return labels[status] || status;
        }
        
        function getPriorityLabel(priority) {
            const labels = {
                'low': 'Baixa',
                'medium': 'Média',
                'high': 'Alta',
                'urgent': 'Urgente'
            };
            return labels[priority] || priority;
        }

        // ========== FUNÇÕES DE TEMPLATES SALVOS ==========
        
        let templatesCarregados = [];
        
        // Carregar lista de templates
        async function carregarListaTemplates() {
            try {
                const response = await fetch('/api/templates');
                const data = await response.json();
                
                if (data.success) {
                    templatesCarregados = data.templates;
                    const select = document.getElementById('templatesSalvos');
                    
                    // Limpar opções existentes
                    select.innerHTML = '<option value="">Selecione um template...</option>';
                    
                    // Adicionar templates
                    data.templates.forEach(template => {
                        const option = document.createElement('option');
                        option.value = template._id;
                        option.textContent = \`\${getTemplateIcon(template.tipoTemplate)} \${template.nome}\`;
                        select.appendChild(option);
                    });
                    
                    console.log(\`📋 \${data.templates.length} templates carregados\`);
                } else {
                    console.error('❌ Erro ao carregar templates:', data.message);
                }
            } catch (error) {
                console.error('❌ Erro ao carregar templates:', error);
            }
        }
        
        // Carregar template selecionado
        async function carregarTemplate() {
            const select = document.getElementById('templatesSalvos');
            const templateId = select.value;
            
            if (!templateId) {
                document.getElementById('template-info').style.display = 'none';
                document.getElementById('template-actions').style.display = 'none';
                window.templateComArquivo = null; // Limpar arquivo do template
                document.getElementById('arquivo-info').innerHTML = '';
                return;
            }
            
            try {
                const response = await fetch(\`/api/templates/\${templateId}\`);
                const data = await response.json();
                
                if (data.success) {
                    const template = data.template;
                    
                    // Carregar dados nos campos
                    document.getElementById('tipoTemplate').value = template.tipoTemplate;
                    alterarTemplate(); // Atualizar interface
                    
                    if (template.mensagem) {
                        document.getElementById('mensagem').value = template.mensagem;
                    }
                    
                    if (template.legenda) {
                        document.getElementById('legenda').value = template.legenda;
                    }
                    
                    // Mostrar informações do template
                    const infoDiv = document.getElementById('template-info');
                    const descDiv = document.getElementById('template-descricao');
                    const statsDiv = document.getElementById('template-stats');
                    
                    descDiv.textContent = template.descrição || 'Sem descrição';
                    statsDiv.innerHTML = \`
                        👤 Por: \${template.criadoPor} | 
                        📅 Criado: \${new Date(template.criadoEm).toLocaleDateString('pt-BR')} | 
                        📊 Usado \${template.vezesUsado}x
                    \`;
                    
                    infoDiv.style.display = 'block';
                    document.getElementById('template-actions').style.display = 'block';
                    
                    // Se tem arquivo, configurar para usar o arquivo do template
                    if (template.arquivo) {
                        const arquivoInfo = document.getElementById('arquivo-info');
                        arquivoInfo.innerHTML = \`
                            <div style="color: #25D366; font-weight: 500; padding: 10px; background: #f0f9ff; border-radius: 8px; border-left: 4px solid #25D366;">
                                📎 Arquivo do template: <strong>\${template.nomeArquivoOriginal || 'arquivo'}</strong>
                                <br><small style="color: #666;">✅ Arquivo será usado automaticamente do template</small>
                            </div>
                        \`;
                        
                        // Marcar que existe arquivo do template para usar no envio
                        window.templateComArquivo = {
                            url: template.arquivo,
                            nome: template.nomeArquivoOriginal,
                            tamanho: template.tamanhoArquivo,
                            mimetype: template.mimetypeArquivo
                        };
                    } else {
                        // Limpar arquivo do template se não houver
                        window.templateComArquivo = null;
                        document.getElementById('arquivo-info').innerHTML = '';
                    }
                    
                    atualizarPreview();
                    mostrarAlerta('success', \`Template "\${template.nome}" carregado com sucesso!\`);
                    
                } else {
                    mostrarAlerta('error', 'Erro ao carregar template: ' + data.message);
                }
            } catch (error) {
                console.error('❌ Erro ao carregar template:', error);
                mostrarAlerta('error', 'Erro ao carregar template');
            }
        }
        
        // Abrir modal para salvar template
        function abrirModalSalvarTemplate() {
            const tipoTemplate = document.getElementById('tipoTemplate').value;
            const mensagem = document.getElementById('mensagem').value;
            const legenda = document.getElementById('legenda').value;
            const arquivo = document.getElementById('arquivo').files[0];
            
            // Validar se há conteúdo para salvar
            if (!mensagem.trim() && !arquivo) {
                mostrarAlerta('warning', 'Adicione uma mensagem ou arquivo antes de salvar o template');
                return;
            }
            
            // Preencher modal
            document.getElementById('modalNomeTemplate').value = '';
            document.getElementById('modalDescricaoTemplate').value = '';
            document.getElementById('modalTipoTemplate').textContent = getTemplateTypeLabel(tipoTemplate);
            
            // Mostrar preview do que será salvo
            let preview = '';
            if (mensagem.trim()) {
                preview += \`📝 Mensagem: "\${mensagem.substring(0, 50)}\${mensagem.length > 50 ? '...' : ''}"\`;
            }
            if (legenda && legenda.trim()) {
                preview += \`<br>📝 Legenda: "\${legenda.substring(0, 50)}\${legenda.length > 50 ? '...' : ''}"\`;
            }
            if (arquivo) {
                preview += \`<br>📎 Arquivo: \${arquivo.name} (\${formatFileSize(arquivo.size)})\`;
            }
            
            document.getElementById('modalPreviewTemplate').innerHTML = preview;
            
            document.getElementById('modalSalvarTemplate').style.display = 'block';
        }
        
        // Salvar template
        async function salvarTemplate() {
            const nome = document.getElementById('modalNomeTemplate').value.trim();
            const descricao = document.getElementById('modalDescricaoTemplate').value.trim();
            
            if (!nome) {
                mostrarAlerta('warning', 'Digite um nome para o template');
                return;
            }
            
            const tipoTemplate = document.getElementById('tipoTemplate').value;
            const mensagem = document.getElementById('mensagem').value;
            const legenda = document.getElementById('legenda').value;
            const arquivo = document.getElementById('arquivo').files[0];
            
            let dadosTemplate = {
                nome,
                descricao,
                tipoTemplate,
                mensagem,
                legenda
            };
            
            // Se há arquivo, fazer upload primeiro
            if (arquivo) {
                try {
                    const formData = new FormData();
                    formData.append('file', arquivo);
                    
                    const uploadResponse = await fetch('/api/upload', {
                        method: 'POST',
                        body: formData
                    });
                    
                    const uploadData = await uploadResponse.json();
                    
                    if (uploadData.success) {
                        dadosTemplate.arquivo = uploadData.file.url;
                        dadosTemplate.nomeArquivoOriginal = uploadData.file.originalName;
                        dadosTemplate.tamanhoArquivo = uploadData.file.size;
                        dadosTemplate.mimetypeArquivo = uploadData.file.mimetype;
                    } else {
                        throw new Error('Falha no upload do arquivo');
                    }
                } catch (error) {
                    console.error('❌ Erro no upload:', error);
                    mostrarAlerta('error', 'Erro ao fazer upload do arquivo');
                    return;
                }
            }
            
            // Salvar template
            try {
                const response = await fetch('/api/templates', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(dadosTemplate)
                });
                
                const data = await response.json();
                
                if (data.success) {
                    fecharModal('modalSalvarTemplate');
                    await carregarListaTemplates();
                    mostrarAlerta('success', \`Template "\${nome}" salvo com sucesso!\`);
                } else {
                    mostrarAlerta('error', 'Erro ao salvar template: ' + data.message);
                }
            } catch (error) {
                console.error('❌ Erro ao salvar template:', error);
                mostrarAlerta('error', 'Erro ao salvar template');
            }
        }
        
        // Excluir template
        async function excluirTemplate() {
            const select = document.getElementById('templatesSalvos');
            const templateId = select.value;
            
            if (!templateId) return;
            
            const template = templatesCarregados.find(t => t._id === templateId);
            if (!template) return;
            
            if (!confirm(\`Tem certeza que deseja excluir o template "\${template.nome}"?\`)) {
                return;
            }
            
            try {
                const response = await fetch(\`/api/templates/\${templateId}\`, {
                    method: 'DELETE'
                });
                
                const data = await response.json();
                
                if (data.success) {
                    await carregarListaTemplates();
                    document.getElementById('template-info').style.display = 'none';
                    document.getElementById('template-actions').style.display = 'none';
                    mostrarAlerta('success', \`Template "\${template.nome}" excluído com sucesso!\`);
                } else {
                    mostrarAlerta('error', 'Erro ao excluir template: ' + data.message);
                }
            } catch (error) {
                console.error('❌ Erro ao excluir template:', error);
                mostrarAlerta('error', 'Erro ao excluir template');
            }
        }
        
        // Funções auxiliares
        function getTemplateIcon(tipo) {
            const icons = {
                'texto': '📝',
                'imagem': '🖼️',
                'imagem-legenda': '🖼️',
                'audio': '🎵',
                'arquivo': '📎',
                'arquivo-legenda': '📎'
            };
            return icons[tipo] || '📄';
        }
        
        function getTemplateTypeLabel(tipo) {
            const labels = {
                'texto': 'Apenas Texto',
                'imagem': 'Imagem',
                'imagem-legenda': 'Imagem + Legenda',
                'audio': 'Áudio',
                'arquivo': 'Arquivo',
                'arquivo-legenda': 'Arquivo + Legenda'
            };
            return labels[tipo] || tipo;
        }
        
        function fecharModal(modalId) {
            document.getElementById(modalId).style.display = 'none';
        }
        
        // Carregar templates ao inicializar
        document.addEventListener('DOMContentLoaded', function() {
            carregarListaTemplates();
        });
        
    </script>
    
    <!-- Modal para Salvar Template -->
    <div id="modalSalvarTemplate" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2 class="modal-title">💾 Salvar Template</h2>
                <span class="close" onclick="fecharModal('modalSalvarTemplate')">&times;</span>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">📝 Nome do Template</label>
                    <input type="text" id="modalNomeTemplate" class="form-input" placeholder="Ex: Bom dia personalizado" required>
                </div>
                
                <div class="form-group">
                    <label class="form-label">📄 Descrição (Opcional)</label>
                    <textarea id="modalDescricaoTemplate" class="form-textarea" placeholder="Descreva quando usar este template..." rows="3"></textarea>
                </div>
                
                <div class="form-group">
                    <label class="form-label">📋 Tipo</label>
                    <div id="modalTipoTemplate" style="padding: 10px; background: #f8f9fa; border-radius: 5px; font-weight: 500;"></div>
                </div>
                
                <div class="form-group">
                    <label class="form-label">👀 Preview</label>
                    <div id="modalPreviewTemplate" style="padding: 10px; background: #f8f9fa; border-radius: 5px; font-size: 0.9rem; color: #666;"></div>
                </div>
            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" onclick="fecharModal('modalSalvarTemplate')">Cancelar</button>
                <button type="button" class="btn btn-primary" onclick="salvarTemplate()">💾 Salvar Template</button>
            </div>
        </div>
    </div>
    
    ${getStandardFooter()}

</body>
</html>
  `;
}

function getWhatsAppManagementHTML() {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Clerky CRM - Gerenciar WhatsApp</title>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <script src="/socket.io/socket.io.js"></script>
        <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
        <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
        <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
        <style>
            ${getStandardHeaderCSS()}
            ${getStandardFooterCSS()}
            
            .status-indicator {
                animation: pulse-status 2s infinite;
            }
            
            @keyframes pulse-status {
                0%, 100% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.05); opacity: 0.8; }
            }
            
            .card-hover {
                transition: all 0.3s ease;
            }
            
            .card-hover:hover {
                transform: translateY(-2px);
                box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            }
            
            .log-container {
                background: #1a1a1a;
                border-radius: 8px;
                font-family: 'Courier New', monospace;
            }
        </style>
    </head>
    <body class="bg-white min-h-screen">
        <div id="app"></div>
        
        <script type="text/babel">
            const { useState, useEffect, useRef } = React;
            
            function WhatsAppManager() {
                const [info, setInfo] = useState({});
                const [loading, setLoading] = useState(false);
                const [logs, setLogs] = useState([]);
                const [refreshInterval, setRefreshInterval] = useState(null);
                const [showQR, setShowQR] = useState(false);
                const socket = useRef(null);
                const logsContainerRef = useRef(null);
                
                useEffect(() => {
                    socket.current = io();
                    
                    socket.current.on('qr-update', (data) => {
                        loadInfo();
                        addLog('🔄 QR Code atualizado');
                    });
                    
                    socket.current.on('client-ready', () => {
                        loadInfo();
                        addLog('✅ WhatsApp conectado com sucesso!');
                    });
                    
                    socket.current.on('client-disconnected', () => {
                        loadInfo();
                        addLog('🔌 WhatsApp desconectado');
                    });
                    
                    socket.current.on('client-authenticated', () => {
                        addLog('🔐 WhatsApp autenticado');
                    });
                    
                    // Receber logs do sistema em tempo real
                    socket.current.on('system-log', (logEntry) => {
                        setLogs(prev => [...prev.slice(-49), logEntry]); // Manter 50 logs
                    });
                    
                    // Receber histórico de logs quando conectar
                    socket.current.on('system-logs-history', (systemLogs) => {
                        setLogs(systemLogs);
                    });
                    
                    loadInfo();
                    
                    // Auto-refresh a cada 5 segundos
                    const interval = setInterval(loadInfo, 5000);
                    setRefreshInterval(interval);
                    
                    return () => {
                        if (socket.current) socket.current.disconnect();
                        if (interval) clearInterval(interval);
                    };
                }, []);
                
                // Auto-scroll para os logs mais recentes
                useEffect(() => {
                    if (logsContainerRef.current) {
                        logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
                    }
                }, [logs]);
                
                const loadInfo = async () => {
                    try {
                        const response = await fetch('/api/whatsapp/info');
                        const data = await response.json();
                        if (data.success) {
                            setInfo(data.info);
                        }
                    } catch (error) {
                        console.error('Erro ao carregar informações:', error);
                        addLog('❌ Erro ao carregar informações: ' + error.message);
                    }
                };
                
                const addLog = (message, type = 'info') => {
                    const timestamp = new Date().toLocaleTimeString('pt-BR');
                    setLogs(prev => [...prev.slice(-49), { timestamp, message, type }]); // Manter 50 logs
                };
                
                const handleDisconnect = async () => {
                    if (loading) return;
                    setLoading(true);
                    addLog('🔌 Desconectando WhatsApp...');
                    
                    try {
                        const response = await fetch('/api/whatsapp/disconnect', { method: 'POST' });
                        const data = await response.json();
                        addLog(data.success ? '✅ ' + data.message : '❌ ' + data.message);
                        if (data.success) setTimeout(loadInfo, 1000);
                    } catch (error) {
                        addLog('❌ Erro ao desconectar: ' + error.message);
                    }
                    setLoading(false);
                };
                
                const handleReconnect = async () => {
                    if (loading) return;
                    setLoading(true);
                    addLog('🔄 Reconectando WhatsApp...');
                    
                    try {
                        const response = await fetch('/api/whatsapp/reconnect', { method: 'POST' });
                        const data = await response.json();
                        addLog(data.success ? '✅ ' + data.message : '❌ ' + data.message);
                        if (data.success) setTimeout(loadInfo, 2000);
                    } catch (error) {
                        addLog('❌ Erro ao reconectar: ' + error.message);
                    }
                    setLoading(false);
                };
                
                const handleClearSession = async () => {
                    if (loading) return;
                    if (!confirm('⚠️ Tem certeza? Isso irá limpar toda a sessão e você precisará escanear o QR Code novamente.')) return;
                    
                    setLoading(true);
                    addLog('🗑️ Limpando sessão WhatsApp...');
                    
                    try {
                        const response = await fetch('/api/whatsapp/clear-session', { method: 'POST' });
                        const data = await response.json();
                        addLog(data.success ? '✅ ' + data.message : '❌ ' + data.message);
                        if (data.success) setTimeout(loadInfo, 3000);
                    } catch (error) {
                        addLog('❌ Erro ao limpar sessão: ' + error.message);
                    }
                    setLoading(false);
                };
                
                const formatUptime = (seconds) => {
                    const hours = Math.floor(seconds / 3600);
                    const minutes = Math.floor((seconds % 3600) / 60);
                    const secs = Math.floor(seconds % 60);
                    return \`\${hours}h \${minutes}m \${secs}s\`;
                };
                
                return (
                    <div className="min-h-screen bg-transparent">
                        {/* Header Padronizado */}
                        <div dangerouslySetInnerHTML={{__html: \`${getStandardHeader('Configurações WhatsApp', '⚙️', 'whatsapp')}\`}}></div>
                        
                        <div className="max-w-6xl mx-auto p-6">
                            {/* Status Cards */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                                {/* Status Principal */}
                                <div className="card-hover bg-white rounded-xl shadow-lg p-6">
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="text-2xl">📱</div>
                                        <div className={'w-4 h-4 rounded-full status-indicator ' + (info.isConnected ? 'bg-green-500' : 'bg-red-500')}></div>
                                    </div>
                                    <h3 className="text-lg font-semibold text-gray-800 mb-2">Status da Conexão</h3>
                                    <p className={'text-sm font-medium ' + (info.isConnected ? 'text-green-600' : 'text-red-600')}>
                                        {info.isConnected ? '🟢 Conectado e Funcionando' : '🔴 Desconectado'}
                                    </p>
                                    <p className="text-xs text-gray-500 mt-2">
                                        Última atualização: {info.timestamp ? new Date(info.timestamp).toLocaleTimeString('pt-BR') : 'N/A'}
                                    </p>
                                </div>
                                
                                {/* Informações do Sistema */}
                                <div className="card-hover bg-white rounded-xl shadow-lg p-6">
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="text-2xl">🖥️</div>
                                        <div className="text-xs text-gray-400">Sistema</div>
                                    </div>
                                    <h3 className="text-lg font-semibold text-gray-800 mb-2">Informações do Sistema</h3>
                                    <div className="space-y-1 text-sm text-gray-600">
                                        <p>⏱️ Uptime: {info.uptime ? formatUptime(info.uptime) : 'N/A'}</p>
                                        <p>🏷️ Versão: {info.version}</p>
                                        <p>⚙️ Node: {info.nodeVersion}</p>
                                        <p>💻 Plataforma: {info.platform}</p>
                                    </div>
                                </div>
                                
                                {/* Sessão WhatsApp */}
                                <div className="card-hover bg-white rounded-xl shadow-lg p-6">
                                    <div className="flex items-center justify-between mb-4">
                                        <div className="text-2xl">👤</div>
                                        <div className="text-xs text-gray-400">Sessão</div>
                                    </div>
                                    <h3 className="text-lg font-semibold text-gray-800 mb-2">Dados da Sessão</h3>
                                    {info.clientState ? (
                                        <div className="space-y-1 text-sm text-gray-600">
                                            <p>📱 Telefone: {info.clientState.wid?.user || 'N/A'}</p>
                                            <p>👤 Nome: {info.clientState.pushname || 'N/A'}</p>
                                            <p>🔋 Bateria: {info.clientState.battery || 'N/A'}%</p>
                                        </div>
                                    ) : (
                                        <p className="text-sm text-gray-500">Nenhuma sessão ativa</p>
                                    )}
                                </div>
                            </div>
                            
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                                {/* Controles */}
                                <div className="bg-white rounded-xl shadow-lg p-6">
                                    <h2 className="text-xl font-bold text-gray-800 mb-6 flex items-center">
                                        🎛️ Controles de Conexão
                                    </h2>
                                    
                                    <div className="space-y-4">
                                        {info.qrCode && (
                                            <div className="border-2 border-dashed border-gray-200 rounded-lg p-4 text-center">
                                                <p className="text-sm text-gray-600 mb-3">📱 Escaneie este QR Code no seu WhatsApp</p>
                                                <img src={info.qrCode} alt="QR Code" className="mx-auto rounded-lg max-w-48" />
                                                <p className="text-xs text-gray-500 mt-2">O QR Code expira em alguns minutos</p>
                                            </div>
                                        )}
                                        
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                            <button
                                                onClick={handleReconnect}
                                                disabled={loading}
                                                className="flex items-center justify-center space-x-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white px-4 py-3 rounded-lg transition-colors font-medium"
                                            >
                                                {loading ? <div className="animate-spin">⏳</div> : <span>🔄</span>}
                                                <span>Reconectar</span>
                                            </button>
                                            
                                            <button
                                                onClick={handleDisconnect}
                                                disabled={loading || !info.isConnected}
                                                className="flex items-center justify-center space-x-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-4 py-3 rounded-lg transition-colors font-medium"
                                            >
                                                <span>🔌</span>
                                                <span>Desconectar</span>
                                            </button>
                                            
                                            <button
                                                onClick={handleClearSession}
                                                disabled={loading}
                                                className="flex items-center justify-center space-x-2 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white px-4 py-3 rounded-lg transition-colors font-medium sm:col-span-2"
                                            >
                                                <span>🗑️</span>
                                                <span>Limpar Sessão</span>
                                            </button>
                                        </div>
                                        
                                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                                            <div className="flex items-start space-x-2">
                                                <div className="text-yellow-600 text-lg">⚠️</div>
                                                <div className="text-sm text-yellow-800">
                                                    <p className="font-medium mb-1">Importante:</p>
                                                    <ul className="space-y-1 text-xs">
                                                        <li>• Limpar sessão remove todos os dados salvos</li>
                                                        <li>• Será necessário escanear o QR Code novamente</li>
                                                        <li>• Desconectar para o WhatsApp mas mantém a sessão</li>
                                                    </ul>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                
                                {/* Logs */}
                                <div className="bg-white rounded-xl shadow-lg p-6">
                                    <div className="flex items-center justify-between mb-6">
                                        <h2 className="text-xl font-bold text-gray-800 flex items-center">
                                            📋 Logs do Sistema
                                        </h2>
                                        <button
                                            onClick={() => setLogs([])}
                                            className="text-sm text-gray-500 hover:text-red-500 transition-colors"
                                        >
                                            🗑️ Limpar
                                        </button>
                                    </div>
                                    
                                    <div ref={logsContainerRef} className="log-container p-4 h-96 overflow-y-auto">
                                        {logs.length === 0 ? (
                                            <div className="text-center text-gray-400 py-8">
                                                <div className="text-3xl mb-2">📝</div>
                                                <p>Nenhum log ainda...</p>
                                                <p className="text-sm mt-1">Os eventos aparecerão aqui</p>
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {logs.map((log, index) => {
                                                    const getLogColor = (type) => {
                                                        switch(type) {
                                                            case 'error': return 'text-red-400';
                                                            case 'warn': return 'text-yellow-400';
                                                            default: return 'text-gray-300';
                                                        }
                                                    };
                                                    
                                                    return React.createElement('div', {
                                                        key: index,
                                                        className: "flex items-start space-x-3 text-sm"
                                                    }, [
                                                        React.createElement('span', {
                                                            key: 'timestamp',
                                                            className: "text-green-400 font-mono text-xs whitespace-nowrap"
                                                        }, log.timestamp),
                                                        React.createElement('span', {
                                                            key: 'message',
                                                            className: 'flex-1 ' + getLogColor(log.type)
                                                        }, log.message)
                                                    ]);
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                
                                {/* Seção de Integrações */}
                                <div className="lg:col-span-2">
                                    <IntegrationsSection />
                                </div>
                            </div>
                        </div>
                    </div>
                );
            }
            
            function IntegrationsSection() {
                const [integrations, setIntegrations] = useState({
                    n8nTestUrl: '',
                    n8nProdUrl: '',
                    n8nSentUrl: '',
                    webhookReceiveUrl: '',
                    iaEnabled: false,
                    massDispatchBypass: true,
                    useTestUrl: false,
                    // Configurações AppMax
                    appmaxEnabled: false,
                    appmaxApiKey: '',
                    appmaxApiUrl: '',
                    appmaxWebhookSecret: ''
                });
                const [loading, setLoading] = useState(false);
                const [testResult, setTestResult] = useState(null);
                const [metadata, setMetadata] = useState(null);
                
                useEffect(() => {
                    loadIntegrations();
                }, []);
                
                const loadIntegrations = async () => {
                    try {
                        const response = await fetch('/api/integrations');
                        const data = await response.json();
                        if (data.success) {
                            setIntegrations(data.integrations);
                            setMetadata(data.metadata);
                        }
                    } catch (error) {
                        console.error('Erro ao carregar integrações:', error);
                    }
                };
                
                const saveIntegrations = async () => {
                    setLoading(true);
                    try {
                        const response = await fetch('/api/integrations', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(integrations)
                        });
                        const data = await response.json();
                        
                        if (data.success) {
                            alert('✅ Integrações salvas com sucesso!');
                        } else {
                            alert('❌ Erro ao salvar: ' + data.message);
                        }
                    } catch (error) {
                        alert('❌ Erro ao salvar integrações: ' + error.message);
                    }
                    setLoading(false);
                };
                
                const testWebhook = async (url, type) => {
                    if (!url) {
                        alert('❌ URL não configurada');
                        return;
                    }
                    
                    setLoading(true);
                    setTestResult(null);
                    
                    try {
                        const response = await fetch('/api/integrations/test', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                url, 
                                type,
                                testData: {
                                    phoneNumber: '5511999999999',
                                    message: 'Teste de integração n8n',
                                    timestamp: new Date().toISOString(),
                                    contactName: 'Teste',
                                    isTest: true
                                }
                            })
                        });
                        
                        const data = await response.json();
                        setTestResult({
                            success: data.success,
                            message: data.message,
                            response: data.response,
                            type
                        });
                        
                    } catch (error) {
                        setTestResult({
                            success: false,
                            message: 'Erro na requisição: ' + error.message,
                            type
                        });
                    }
                    setLoading(false);
                };
                
                const generateWebhookUrl = () => {
                    const baseUrl = window.location.origin;
                    return baseUrl + '/webhook/n8n/receive';
                };
                
                return (
                    <div className="bg-white rounded-xl shadow-lg p-6 mt-6">
                        <div className="flex items-center justify-between mb-6">
                            <div>
                                <h2 className="text-xl font-bold text-gray-800 flex items-center">
                                    🔗 Integrações & IA
                                </h2>
                                {metadata && (
                                    <p className="text-xs text-gray-500 mt-1">
                                        💾 Última alteração: {new Date(metadata.updatedAt).toLocaleString('pt-BR')} 
                                                                                 {metadata.updatedBy && ' por ' + metadata.updatedBy}
                                    </p>
                                )}
                            </div>
                            <div className="flex space-x-2">
                                <button
                                    onClick={saveIntegrations}
                                    disabled={loading}
                                    className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                                >
                                    {loading ? '⏳ Salvando...' : '💾 Salvar'}
                                </button>
                            </div>
                        </div>
                        
                        {/* Controle de Ambiente - Posição Destacada */}
                        <div className="mb-8">
                            <div className={integrations.useTestUrl ? 'bg-gradient-to-r from-blue-50 to-blue-100 border-2 border-blue-200 p-6 rounded-xl shadow-lg' : 'bg-gradient-to-r from-green-50 to-green-100 border-2 border-green-200 p-6 rounded-xl shadow-lg'}>
                                <div className="text-center mb-4">
                                    <h3 className="text-xl font-bold text-gray-800 mb-3 flex items-center justify-center">
                                        🔄 Ambiente de Operação
                                    </h3>
                                    <div className={integrations.useTestUrl ? 'inline-flex items-center px-6 py-3 bg-blue-100 border-2 border-blue-300 rounded-full shadow-sm' : 'inline-flex items-center px-6 py-3 bg-green-100 border-2 border-green-300 rounded-full shadow-sm'}>
                                        <span className={integrations.useTestUrl ? 'text-blue-700 font-bold text-lg' : 'text-green-700 font-bold text-lg'}>
                                            {integrations.useTestUrl ? '🧪 MODO TESTE ATIVO' : '🚀 MODO PRODUÇÃO ATIVO'}
                                        </span>
                                    </div>
                                </div>
                                
                                <div className="flex items-center justify-center space-x-8">
                                    <div className="text-center">
                                        <div className={!integrations.useTestUrl ? 'text-green-600 text-3xl mb-2 transform scale-110' : 'text-gray-400 text-3xl mb-2'}>
                                            🚀
                                        </div>
                                        <span className={!integrations.useTestUrl ? 'text-base font-bold text-green-700' : 'text-base text-gray-500'}>
                                            Produção
                                        </span>
                                    </div>
                                    
                                    <label className="relative inline-flex items-center cursor-pointer transform hover:scale-110 transition-all duration-200">
                                        <input
                                            type="checkbox"
                                            checked={integrations.useTestUrl}
                                            onChange={(e) => setIntegrations(prev => ({...prev, useTestUrl: e.target.checked}))}
                                            className="sr-only peer"
                                        />
                                        <div className="w-20 h-10 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-10 peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-9 after:w-9 after:transition-all peer-checked:bg-blue-500 shadow-lg"></div>
                                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                            <span className={integrations.useTestUrl ? 'text-sm font-bold text-white ml-3' : 'text-sm font-bold text-gray-600 mr-3'}>
                                                {integrations.useTestUrl ? 'TEST' : 'PROD'}
                                            </span>
                                        </div>
                                    </label>
                                    
                                    <div className="text-center">
                                        <div className={integrations.useTestUrl ? 'text-blue-600 text-3xl mb-2 transform scale-110' : 'text-gray-400 text-3xl mb-2'}>
                                            🧪
                                        </div>
                                        <span className={integrations.useTestUrl ? 'text-base font-bold text-blue-700' : 'text-base text-gray-500'}>
                                            Teste
                                        </span>
                                    </div>
                                </div>
                                
                                <div className="mt-6 text-center">
                                    <p className={integrations.useTestUrl ? 'text-sm text-blue-600 font-semibold bg-blue-50 px-4 py-2 rounded-lg border border-blue-200' : 'text-sm text-green-600 font-semibold bg-green-50 px-4 py-2 rounded-lg border border-green-200'}>
                                        {integrations.useTestUrl ? 
                                            '⚠️ Mensagens recebidas serão enviadas para ambiente de TESTE' : 
                                            '✅ Mensagens recebidas serão enviadas para ambiente de PRODUÇÃO'
                                        }
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Configurações n8n */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <div className="space-y-4">
                                <h3 className="text-lg font-semibold text-gray-700 flex items-center">
                                    🤖 Webhooks n8n
                                </h3>
                                
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        🧪 URL de Teste (n8n)
                                    </label>
                                    <div className="flex space-x-2">
                                        <input
                                            type="url"
                                            value={integrations.n8nTestUrl}
                                            onChange={(e) => setIntegrations(prev => ({...prev, n8nTestUrl: e.target.value}))}
                                            placeholder="https://seu-n8n.com/webhook/test"
                                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-sm"
                                        />
                                        <button
                                            onClick={() => testWebhook(integrations.n8nTestUrl, 'test')}
                                            disabled={loading || !integrations.n8nTestUrl}
                                            className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                                        >
                                            🧪 Testar
                                        </button>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Webhook para ambiente de desenvolvimento/teste
                                    </p>
                                </div>
                                
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        🚀 URL de Produção (n8n)
                                    </label>
                                    <div className="flex space-x-2">
                                        <input
                                            type="url"
                                            value={integrations.n8nProdUrl}
                                            onChange={(e) => setIntegrations(prev => ({...prev, n8nProdUrl: e.target.value}))}
                                            placeholder="https://seu-n8n.com/webhook/prod"
                                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 text-sm"
                                        />
                                        <button
                                            onClick={() => testWebhook(integrations.n8nProdUrl, 'prod')}
                                            disabled={loading || !integrations.n8nProdUrl}
                                            className="bg-green-500 hover:bg-green-600 text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                                        >
                                            🚀 Testar
                                        </button>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Webhook para ambiente de produção
                                    </p>
                                </div>
                                

                                
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        📤 URL para Mensagens Enviadas (fromMe = true)
                                    </label>
                                    <div className="flex space-x-2">
                                        <input
                                            type="url"
                                            value={integrations.n8nSentUrl}
                                            onChange={(e) => setIntegrations(prev => ({...prev, n8nSentUrl: e.target.value}))}
                                            placeholder="https://seu-n8n.com/webhook/sent"
                                            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                                        />
                                        <button
                                            onClick={() => testWebhook(integrations.n8nSentUrl, 'sent')}
                                            disabled={loading || !integrations.n8nSentUrl}
                                            className="bg-purple-500 hover:bg-purple-600 text-white px-3 py-2 rounded-lg text-sm disabled:opacity-50"
                                        >
                                            📤 Testar
                                        </button>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Webhook disparado quando você envia mensagem (do celular ou sistema)
                                    </p>
                                </div>
                                
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-2">
                                        📨 URL para Receber Respostas
                                    </label>
                                    <div className="flex space-x-2">
                                        <input
                                            type="text"
                                            value={generateWebhookUrl()}
                                            readOnly
                                            className="flex-1 px-3 py-2 bg-gray-100 border border-gray-300 rounded-lg text-sm text-gray-600"
                                        />
                                        <button
                                            onClick={() => navigator.clipboard.writeText(generateWebhookUrl())}
                                            className="bg-gray-500 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-sm"
                                        >
                                            📋 Copiar
                                        </button>
                                    </div>
                                    <p className="text-xs text-gray-500 mt-1">
                                        Configure esta URL no n8n para enviar respostas da IA
                                    </p>
                                </div>
                            </div>
                            
                            <div className="space-y-4">
                                <h3 className="text-lg font-semibold text-gray-700 flex items-center">
                                    🧠 Configurações da IA
                                </h3>
                                
                                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                                    <div className="flex items-center justify-between mb-3">
                                        <label className="text-sm font-medium text-blue-800">
                                            🤖 Ativar IA para Conversas
                                        </label>
                                        <button
                                            onClick={() => setIntegrations(prev => ({...prev, iaEnabled: !prev.iaEnabled}))}
                                            className={integrations.iaEnabled ? 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors bg-green-500' : 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors bg-gray-300'}
                                        >
                                            <span className={integrations.iaEnabled ? 'inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-6' : 'inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1'} />
                                        </button>
                                    </div>
                                    <p className="text-xs text-blue-700">
                                        Quando ativado, mensagens recebidas serão enviadas para o n8n para processamento pela IA
                                    </p>
                                </div>
                                
                                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                                    <div className="flex items-center justify-between mb-3">
                                        <label className="text-sm font-medium text-yellow-800">
                                            🚫 Ignorar Disparos em Massa
                                        </label>
                                        <button
                                            onClick={() => setIntegrations(prev => ({...prev, massDispatchBypass: !prev.massDispatchBypass}))}
                                            className={integrations.massDispatchBypass ? 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors bg-green-500' : 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors bg-gray-300'}
                                        >
                                            <span className={integrations.massDispatchBypass ? 'inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-6' : 'inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1'} />
                                        </button>
                                    </div>
                                    <p className="text-xs text-yellow-700">
                                        Quando ativado, disparos em massa NÃO acionarão a IA (recomendado)
                                    </p>
                                </div>
                                
                                {testResult && (
                                    <div className={testResult.success ? 'border rounded-lg p-4 bg-green-50 border-green-200' : 'border rounded-lg p-4 bg-red-50 border-red-200'}>
                                        <h4 className={testResult.success ? 'text-sm font-medium mb-2 text-green-800' : 'text-sm font-medium mb-2 text-red-800'}>
                                            {testResult.success ? '✅' : '❌'} Resultado do Teste ({testResult.type})
                                        </h4>
                                        <p className={testResult.success ? 'text-xs text-green-700' : 'text-xs text-red-700'}>
                                            {testResult.message}
                                        </p>
                                        {testResult.response && (
                                            <details className="mt-2">
                                                <summary className={testResult.success ? 'text-xs cursor-pointer text-green-600' : 'text-xs cursor-pointer text-red-600'}>
                                                    Ver resposta completa
                                                </summary>
                                                <pre className={testResult.success ? 'text-xs mt-2 p-2 rounded bg-white border overflow-auto max-h-32 border-green-200' : 'text-xs mt-2 p-2 rounded bg-white border overflow-auto max-h-32 border-red-200'}>
                                                    {JSON.stringify(testResult.response, null, 2)}
                                                </pre>
                                            </details>
                                        )}
                                    </div>
                                )}
                                
                                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                                    <h4 className="text-sm font-medium text-gray-800 mb-2">
                                        📋 Como Configurar:
                                    </h4>
                                    <ol className="text-xs text-gray-600 space-y-1">
                                        <li>1. Configure seus webhooks n8n acima</li>
                                        <li>2. No n8n, configure a URL de resposta</li>
                                        <li>3. Ative a IA para conversas</li>
                                        <li>4. Teste as conexões</li>
                                        <li>5. Monitore os logs para verificar funcionamento</li>
                                    </ol>
                                </div>
                            </div>
                        </div>
                        
                        {/* Seção AppMax */}
                        <div className="mt-8 bg-gradient-to-r from-purple-50 to-indigo-50 border-2 border-purple-200 rounded-xl shadow-lg p-6">
                            <div className="flex items-center justify-between mb-6">
                                <div>
                                    <h3 className="text-xl font-bold text-purple-800 flex items-center">
                                        🏢 Integração AppMax CRM
                                    </h3>
                                    <p className="text-sm text-purple-600 mt-1">
                                        Receba leads automaticamente da AppMax no seu WhatsApp
                                    </p>
                                </div>
                                <div className="flex items-center space-x-3">
                                    <span className={integrations.appmaxEnabled ? 'text-sm font-medium text-green-700' : 'text-sm font-medium text-gray-500'}>
                                        {integrations.appmaxEnabled ? '🟢 Ativo' : '🔴 Inativo'}
                                    </span>
                                    <button
                                        onClick={() => setIntegrations(prev => ({...prev, appmaxEnabled: !prev.appmaxEnabled}))}
                                        className={integrations.appmaxEnabled ? 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors bg-green-500' : 'relative inline-flex h-6 w-11 items-center rounded-full transition-colors bg-gray-300'}
                                    >
                                        <span className={integrations.appmaxEnabled ? 'inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-6' : 'inline-block h-4 w-4 transform rounded-full bg-white transition-transform translate-x-1'} />
                                    </button>
                                </div>
                            </div>
                            
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                {/* Configurações da AppMax */}
                                <div className="space-y-4">
                                    <h4 className="text-lg font-semibold text-purple-700 flex items-center">
                                        ⚙️ Configurações
                                    </h4>
                                    
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-2">
                                            🔑 API Key da AppMax
                                        </label>
                                        <input
                                            type="password"
                                            value={integrations.appmaxApiKey}
                                            onChange={(e) => setIntegrations(prev => ({...prev, appmaxApiKey: e.target.value}))}
                                            placeholder="Sua chave de API da AppMax"
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                                        />
                                    </div>
                                    
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-2">
                                            🌐 URL da API AppMax
                                        </label>
                                        <input
                                            type="url"
                                            value={integrations.appmaxApiUrl}
                                            onChange={(e) => setIntegrations(prev => ({...prev, appmaxApiUrl: e.target.value}))}
                                            placeholder="https://api.appmax.com.br/v1/"
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                                        />
                                    </div>
                                    
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-2">
                                            🔐 Webhook Secret (Opcional)
                                        </label>
                                        <input
                                            type="password"
                                            value={integrations.appmaxWebhookSecret}
                                            onChange={(e) => setIntegrations(prev => ({...prev, appmaxWebhookSecret: e.target.value}))}
                                            placeholder="Secret para validar webhooks"
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                                        />
                                        <p className="text-xs text-gray-500 mt-1">
                                            Use para validar a origem dos webhooks (recomendado)
                                        </p>
                                    </div>
                                </div>
                                
                                {/* Informações do Webhook */}
                                <div className="space-y-4">
                                    <h4 className="text-lg font-semibold text-purple-700 flex items-center">
                                        📡 Webhook da AppMax
                                    </h4>
                                    
                                    <div className="bg-white border border-purple-200 rounded-lg p-4">
                                        <label className="block text-sm font-medium text-gray-700 mb-2">
                                            🔗 URL do Webhook
                                        </label>
                                        <div className="flex items-center space-x-2">
                                            <input
                                                type="text"
                                                value={window.location.origin + '/webhook/appmax/receive'}
                                                readOnly
                                                className="flex-1 px-3 py-2 bg-gray-50 border border-gray-300 rounded-lg text-sm"
                                            />
                                            <button
                                                onClick={() => {
                                                    navigator.clipboard.writeText(window.location.origin + '/webhook/appmax/receive');
                                                    alert('✅ URL copiada para a área de transferência!');
                                                }}
                                                className="px-3 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg text-sm transition-colors"
                                            >
                                                📋 Copiar
                                            </button>
                                        </div>
                                        <p className="text-xs text-gray-500 mt-2">
                                            Configure esta URL na AppMax para receber webhooks de leads
                                        </p>
                                    </div>
                                    
                                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                                        <h5 className="text-sm font-medium text-purple-800 mb-2">
                                            📋 Eventos Suportados:
                                        </h5>
                                        <ul className="text-xs text-purple-700 space-y-1">
                                            <li>• <strong>OrderPaid</strong> - Pedido pago (Cartão) 💳</li>
                                            <li>• <strong>OrderPaidByPix</strong> - Pedido pago (PIX) 📱</li>
                                            <li>• <strong>OrderPaidByBillet</strong> - Pedido pago (Boleto) 🧾</li>
                                            <li>• <strong>lead.created</strong> - Novo lead criado</li>
                                            <li>• <strong>lead.updated</strong> - Lead atualizado</li>
                                            <li>• <strong>contact.created</strong> - Novo contato</li>
                                            <li>• <strong>contact.updated</strong> - Contato atualizado</li>
                                            <li>• <strong>deal.created</strong> - Nova oportunidade</li>
                                            <li>• <strong>deal.updated</strong> - Oportunidade atualizada</li>
                                        </ul>
                                    </div>
                                    
                                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                                        <h5 className="text-sm font-medium text-blue-800 mb-2">
                                            🎯 Funcionalidades:
                                        </h5>
                                        <ul className="text-xs text-blue-700 space-y-1">
                                            <li>✅ Criação automática de clientes no CRM</li>
                                            <li>✅ Formatação inteligente de números</li>
                                            <li>✅ Mensagem de confirmação de pedido automática</li>
                                            <li>✅ Sincronização de pedidos, valores e produtos</li>
                                            <li>✅ Histórico completo em notas</li>
                                            <li>✅ Status automático: lead → cliente</li>
                                            <li>✅ Prioridade alta para pedidos pagos</li>
                                        </ul>
                                    </div>
                                    
                                    <div className="flex space-x-2">
                                        <a
                                            href="/webhook/appmax/test"
                                            target="_blank"
                                            className="flex-1 px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg text-sm text-center transition-colors"
                                        >
                                            🧪 Testar Endpoint
                                        </a>
                                        <button
                                            onClick={() => {
                                                const testPayload = {
                                                    environment: 'production',
                                                    event: 'OrderPaid',
                                                    data: {
                                                        id: 999,
                                                        status: 'aprovado',
                                                        total: 199.90,
                                                        payment_type: 'CreditCard',
                                                        customer: {
                                                            firstname: 'João',
                                                            lastname: 'Teste',
                                                            fullname: 'João Teste',
                                                            email: 'joao@teste.com',
                                                            telephone: '11999999999'
                                                        },
                                                        bundles: [{
                                                            name: 'Produto Teste',
                                                            products: [{
                                                                name: 'Item Teste',
                                                                quantity: 1
                                                            }]
                                                        }]
                                                    }
                                                };
                                                
                                                fetch('/webhook/appmax/receive', {
                                                    method: 'POST',
                                                    headers: {
                                                        'Content-Type': 'application/json',
                                                        ...(integrations.appmaxWebhookSecret && {
                                                            'X-AppMax-Signature': integrations.appmaxWebhookSecret
                                                        })
                                                    },
                                                    body: JSON.stringify(testPayload)
                                                })
                                                .then(response => response.json())
                                                .then(data => {
                                                    if (data.success) {
                                                        alert('✅ Teste realizado com sucesso! Verifique o console para logs.');
                                                    } else {
                                                        alert('❌ Erro no teste: ' + data.message);
                                                    }
                                                })
                                                .catch(error => {
                                                    alert('❌ Erro na requisição: ' + error.message);
                                                });
                                            }}
                                            className="flex-1 px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm transition-colors"
                                        >
                                            🚀 Testar Integração
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            }
            
            const root = ReactDOM.createRoot(document.getElementById('app'));
            root.render(<WhatsAppManager />);
        </script>
        
        ${getStandardFooter()}
    </body>
    </html>
  `;
}

function getMainHTML() {
  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Clerky CRM - WhatsApp</title>
        <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
        <script src="/socket.io/socket.io.js"></script>
        <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
        <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
        <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
        <script src="https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js" type="module"></script>
        <style>
            ${getStandardHeaderCSS()}
            ${getStandardFooterCSS()}
            
            .message-bubble {
                animation: fadeIn 0.3s ease-in;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            /* Estilos para cards de contatos */
            .contact-card {
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            
            .contact-card:hover {
                transform: translateY(-4px);
                box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
            }
            
            .contact-card.selected {
                transform: translateY(-4px);
                box-shadow: 0 20px 25px -5px rgba(34, 197, 94, 0.2), 0 10px 10px -5px rgba(34, 197, 94, 0.1);
            }
            
            /* Estilos para colunas de status */
            .status-column {
                min-height: 600px;
            }
            
            .status-column .contact-card {
                transform: none;
            }
            
            .status-column .contact-card:hover {
                transform: translateY(-2px);
                box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
            }
            
            .pulse-green {
                animation: pulse-green 2s infinite;
            }
            
            @keyframes pulse-green {
                0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
                70% { box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
            }
            
            .emoji-picker {
                position: absolute;
                bottom: 60px;
                right: 10px;
                z-index: 1000;
                border-radius: 12px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                background: white;
            }
            
            .emoji-button {
                transition: all 0.2s ease;
            }
            
            .emoji-button:hover {
                transform: scale(1.1);
                background-color: #f3f4f6;
            }
            
            .message-emoji {
                font-size: 1.2em;
            }
            
            /* Estilo customizado para player de áudio */
            audio {
                outline: none;
                border-radius: 8px;
                background: #f8f9fa;
                border: 1px solid #e9ecef;
            }
            
            audio::-webkit-media-controls-panel {
                background-color: #ffffff;
                border-radius: 8px;
            }
            
            audio::-webkit-media-controls-play-button,
            audio::-webkit-media-controls-pause-button {
                background-color: #10b981;
                border-radius: 50%;
                margin-left: 8px;
            }
            
            audio::-webkit-media-controls-timeline {
                background-color: #e5e7eb;
                border-radius: 4px;
                margin: 0 10px;
            }
            
            audio::-webkit-media-controls-current-time-display,
            audio::-webkit-media-controls-time-remaining-display {
                color: #374151;
                font-size: 12px;
            }
            
            /* Corrigir scroll das mensagens */
            .messages-container {
                height: 100%;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
            }
            
            .messages-list {
                flex: 1;
                overflow-y: auto;
                padding: 1rem;
            }
            
            .message-item {
                margin-bottom: 0.5rem;
            }
            
            .messages-end {
                height: 1px;
                width: 100%;
            }
            
            /* Estilos para múltiplos popups de chat arrastáveis */
            .chat-popup {
                animation: slideInUp 0.3s ease-out;
                box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
                user-select: none;
            }
            
            .chat-popup:hover {
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            }
            
            /* Header arrastável */
            .chat-popup .cursor-grab:active {
                cursor: grabbing !important;
            }
            
            /* Animações */
            @keyframes slideInUp {
                from {
                    opacity: 0;
                    transform: translateY(30px) scale(0.95);
                }
                to {
                    opacity: 1;
                    transform: translateY(0) scale(1);
                }
            }
            
            .chat-popup .message-bubble {
                animation: fadeInMessage 0.3s ease-out;
            }
            
            @keyframes fadeInMessage {
                from {
                    opacity: 0;
                    transform: translateY(10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            
            @keyframes slideInFromRight {
                from {
                    opacity: 0;
                    transform: translateX(100%);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }
            
            /* Estilo para popups em foco */
            .chat-popup[style*="z-index: 1000"] {
                transform: scale(1.02);
                transition: transform 0.2s ease;
            }
            
            /* Borda do popup arrastável */
            .chat-popup {
                border: 2px solid transparent;
                transition: border-color 0.2s ease;
            }
            
            .chat-popup:hover {
                border-color: rgba(34, 197, 94, 0.3);
            }
            
            /* Indicador de múltiplos chats */
            .multiple-chats-indicator {
                position: fixed;
                top: 80px;
                right: 20px;
                background: white;
                border: 1px solid #e5e7eb;
                border-radius: 8px;
                padding: 8px 12px;
                font-size: 12px;
                color: #6b7280;
                z-index: 999;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }
            
            /* Estilos para o botão de ocultar filtros */
            .filter-toggle-btn {
                transition: all 0.3s ease;
                border: 1px solid #e5e7eb;
            }
            
            .filter-toggle-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
            }
            
            /* Responsividade para filtros */
            @media (max-width: 1024px) {
                .filter-toggle-btn span {
                    display: none;
                }
                
                .filter-toggle-btn {
                    padding: 8px;
                    border-radius: 50%;
                }
            }
            
            @media (max-width: 768px) {
                .filter-toggle-btn {
                    padding: 6px;
                    font-size: 0.8rem;
                }
                
                .filter-toggle-btn i {
                    font-size: 0.9rem;
                }
            }
        </style>
    </head>
    <body class="bg-gradient-to-br from-green-400 to-blue-500 h-screen overflow-hidden">
        <div id="app"></div>
        
        <script type="text/babel">
            const { useState, useEffect, useRef } = React;
            
            function App() {
                const [isConnected, setIsConnected] = useState(false);
                const [qrCode, setQrCode] = useState(null);
                const [contacts, setContacts] = useState([]);
                const [selectedContact, setSelectedContact] = useState(null);
                const [messages, setMessages] = useState([]);
                const [newMessage, setNewMessage] = useState('');
                const [loading, setLoading] = useState(false);
                const [searchTerm, setSearchTerm] = useState('');
                const [showEmojiPicker, setShowEmojiPicker] = useState(false);
                const [selectedFile, setSelectedFile] = useState(null);
                const [uploadProgress, setUploadProgress] = useState(0);
                const [showFilePreview, setShowFilePreview] = useState(false);
                const [isRecording, setIsRecording] = useState(false);
                const [mediaRecorder, setMediaRecorder] = useState(null);
                const [audioBlob, setAudioBlob] = useState(null);
                const [showCRM, setShowCRM] = useState(true);
                const [clientData, setClientData] = useState(null);
                const [loadingClient, setLoadingClient] = useState(false);
                const [newNote, setNewNote] = useState('');
                const [crmFilters, setCrmFilters] = useState({
                    status: '',
                    priority: '',
                    minValue: '',
                    maxValue: ''
                });
                const [showReports, setShowReports] = useState(false);
                const [reportData, setReportData] = useState(null);
                const [openChats, setOpenChats] = useState([]); // Array de chats abertos
                const [loadingContacts, setLoadingContacts] = useState(true);
                const [statusUpdateCounter, setStatusUpdateCounter] = useState(0); // Para forçar re-renderização das colunas
    const [showFilters, setShowFilters] = useState(true); // Controla visibilidade dos filtros
                const messagesEndRef = useRef(null);
                const socket = useRef(null);
                
                // Função para forçar atualização das colunas do CRM
                const forceColumnUpdate = () => {
                    setStatusUpdateCounter(prev => prev + 1);
                    console.log('🔄 Forçando atualização das colunas do CRM');
                };
                const emojiPickerRef = useRef(null);
                const fileInputRef = useRef(null);
                const recordingInterval = useRef(null);
                const messagesContainerRefs = useRef({}); // Refs para cada container de mensagens
                
                useEffect(() => {
                    console.log('🔌 Inicializando Socket.io...');
                    socket.current = io();
                    
                    socket.current.on('connect', () => {
                        console.log('✅ Socket.io conectado com sucesso!');
                    });
                    
                    socket.current.on('disconnect', () => {
                        console.log('❌ Socket.io desconectado');
                    });
                    
                    socket.current.on('qr-update', (data) => {
                        console.log('📱 QR Code atualizado');
                        setQrCode(data.qrCode);
                        setIsConnected(false);
                    });
                    
                    socket.current.on('client-ready', () => {
                        console.log('🟢 WhatsApp cliente pronto');
                        setIsConnected(true);
                        setQrCode(null);
                        loadContacts();
                    });
                    
                    socket.current.on('client-disconnected', () => {
                        console.log('🔴 WhatsApp cliente desconectado');
                        setIsConnected(false);
                        setQrCode(null);
                    });
                    
                    socket.current.on('messages-read', (data) => {
                        console.log('👁️ Mensagens marcadas como lidas:', data.phoneNumber);
                        // Atualizar contador na lista de contatos
                        setContacts(prev => prev.map(contact => 
                            contact.phoneNumber === data.phoneNumber 
                                ? { ...contact, unreadCount: 0 }
                                : contact
                        ));
                        
                        // Atualizar contador do contato selecionado também
                        if (selectedContact && selectedContact.phoneNumber === data.phoneNumber) {
                            setSelectedContact(prev => ({ ...prev, unreadCount: 0 }));
                        }
                    });
                    
                    loadStatus();
                    loadContacts();
                    
                    return () => socket.current.disconnect();
                }, []);
                
                // UseEffect para eventos do Socket - atualizado para múltiplos chats
                useEffect(() => {
                    if (!socket.current) return;
                    
                    const handleNewMessage = (data) => {
                        console.log('🔔 Nova mensagem recebida:', data.contactId, data.message?.body);
                        console.log('📤 Mensagem enviada por mim?', data.message?.isFromMe);
                        
                        // Atualizar mensagens em todos os chats abertos que correspondem ao contato
                        setOpenChats(prevChats => {
                            console.log('📱 Chats abertos:', prevChats.map(c => ({ id: c.id, phone: c.contact.phoneNumber, name: c.contact.name })));
                            
                            let chatFound = false;
                            const updatedChats = prevChats.map(chat => {
                                // Verificar se a mensagem já existe no chat para evitar duplicação
                                const messageExists = chat.messages.some(msg => 
                                    msg.messageId === data.message?.messageId || 
                                    (msg.timestamp === data.message?.timestamp && msg.body === data.message?.body)
                                );
                                
                                if (messageExists) {
                                    console.log('🔒 Mensagem já existe no chat, evitando duplicação:', data.message?.messageId);
                                    return chat;
                                }
                                // Para mensagens enviadas por mim, procurar pelo chat do destinatário
                                // Para mensagens recebidas, procurar pelo chat do remetente
                                let shouldAddToThisChat = false;
                                
                                if (data.message?.isFromMe) {
                                    // Mensagem enviada por mim - adicionar ao chat do destinatário
                                    // Usar tanto chatId quanto contactId para identificar o chat
                                    const chatIdFromBackend = data.message?.chatId || '';
                                    const destinatarioFromChatId = chatIdFromBackend.replace('@c.us', '');
                                    const contactIdFromBackend = data.contactId || '';
                                    
                                    shouldAddToThisChat = chat.contact.phoneNumber === destinatarioFromChatId || 
                                                         chat.contact.phoneNumber === contactIdFromBackend ||
                                                         chat.contact._id === contactIdFromBackend;
                                    
                                    console.log('📤 Mensagem enviada - Chat:', chat.contact.phoneNumber, 'Match:', shouldAddToThisChat);
                                } else {
                                    // Mensagem recebida - adicionar ao chat do remetente
                                    shouldAddToThisChat = chat.contact.phoneNumber === data.contactId || chat.contact._id === data.contactId;
                                    console.log('📥 Mensagem recebida - verificando chat:', chat.contact.phoneNumber, 'vs contactId:', data.contactId);
                                }
                                
                                if (shouldAddToThisChat) {
                                    chatFound = true;
                                    console.log('✅ Adicionando mensagem ao chat:', chat.contact.name, 'Tipo:', data.message?.type, 'FromMe:', data.message?.isFromMe);
                                    
                                    // Para mensagens recebidas (não enviadas por mim), fazer scroll automático
                                    if (!data.message?.isFromMe) {
                                        setTimeout(() => {
                                            const chatContainer = messagesContainerRefs.current[chat.id];
                                            if (chatContainer) {
                                                // Verificar se estava próximo do final antes de fazer scroll
                                                const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 100;
                                                if (isNearBottom) {
                                                    chatContainer.scrollTop = chatContainer.scrollHeight;
                                                }
                                            }
                                        }, 50);
                                    }
                                    
                                    console.log('✅ Adicionando mensagem ao chat:', chat.contact.name, 'Tipo:', data.message?.type, 'FromMe:', data.message?.isFromMe);
                                    
                                    return {
                                        ...chat,
                                        messages: [...chat.messages, data.message]
                                    };
                                }
                                return chat;
                            });
                            
                            if (!chatFound) {
                                console.log('⚠️ Nenhum chat encontrado para a mensagem');
                                console.log('📧 ContactId:', data.contactId, 'IsFromMe:', data.message?.isFromMe);
                                console.log('📱 Chats disponíveis:', prevChats.map(c => c.contact.phoneNumber));
                            } else {
                                console.log('✅ Chat encontrado e mensagem adicionada com sucesso');
                            }
                            
                            return updatedChats;
                        });
                        
                        // Atualizar apenas a última mensagem dos contatos sem recarregar tudo
                        if (data.contactId && data.message) {
                            setContacts(prevContacts => {
                                const updatedContacts = prevContacts.map(contact => 
                                    contact.phoneNumber === data.contactId || contact._id === data.contactId
                                        ? { 
                                            ...contact, 
                                            lastMessage: data.message.body || '[Mídia]',
                                            lastMessageTime: new Date(data.message.timestamp),
                                            unreadCount: data.message.isFromMe ? contact.unreadCount : (contact.unreadCount || 0) + 1
                                        }
                                        : contact
                                );
                                
                                // Ordenar contatos por última mensagem (mais recente primeiro) dentro de cada status
                                return updatedContacts.sort((a, b) => {
                                    // Primeiro, manter agrupamento por status
                                    const statusOrder = { 'novo': 1, 'andamento': 2, 'aprovado': 3, 'reprovado': 4 };
                                    const aStatus = a.crmData?.status || 'novo';
                                    const bStatus = b.crmData?.status || 'novo';
                                    
                                    if (statusOrder[aStatus] !== statusOrder[bStatus]) {
                                        return statusOrder[aStatus] - statusOrder[bStatus];
                                    }
                                    
                                    // Dentro do mesmo status, ordenar por última mensagem (mais recente primeiro)
                                    const aTime = new Date(a.lastMessageTime || 0);
                                    const bTime = new Date(b.lastMessageTime || 0);
                                    return bTime - aTime;
                                });
                            });
                        }
                    };
                    
                    socket.current.on('new-message', handleNewMessage);
                    
                    // Event listener para novos contatos
                    socket.current.on('new-contact', (data) => {
                        console.log('👤 Novo contato detectado:', data.contact);
                        
                        setContacts(prevContacts => {
                            // Verificar se o contato já existe
                            const contactExists = prevContacts.some(c => 
                                c.phoneNumber === data.contact.phoneNumber
                            );
                            
                            if (!contactExists) {
                                console.log('✅ Adicionando novo contato à lista:', data.contact.name || data.contact.phoneNumber);
                                
                                // Adicionar novo contato no início da lista (mais recente primeiro)
                                const newContact = {
                                    ...data.contact,
                                    crmData: null // Novo contato começa sem dados de CRM
                                };
                                
                                return [newContact, ...prevContacts];
                            } else {
                                console.log('ℹ️ Contato já existe na lista, não adicionando duplicata');
                                return prevContacts;
                            }
                        });
                    });
                    
                    // Event listeners para limpeza de conversas
                    const handleConversationCleared = (data) => {
                        console.log('🗑️ Conversa limpa:', data.phoneNumber);
                        
                        // Limpar mensagens dos chats correspondentes
                        setOpenChats(prevChats => {
                            return prevChats.map(chat => {
                                if (chat.contact.phoneNumber === data.phoneNumber) {
                                    return { ...chat, messages: [] };
                                }
                                return chat;
                            });
                        });
                        
                        setTimeout(loadContacts, 500);
                    };
                    
                    const handleAllConversationsCleared = () => {
                        console.log('🗑️ Todas as conversas foram limpas');
                        
                        // Limpar mensagens de todos os chats abertos
                        setOpenChats(prevChats => {
                            return prevChats.map(chat => ({ ...chat, messages: [] }));
                        });
                        
                        setTimeout(loadContacts, 500);
                    };
                    
                    socket.current.on('conversation-cleared', handleConversationCleared);
                    socket.current.on('conversations-cleared', handleAllConversationsCleared);
                    
                    // Event listener para atualização de status via webhook n8n
                    const handleClientStatusUpdated = (data) => {
                        console.log('🔥 FRONTEND - EVENTO RECEBIDO client-status-updated:', JSON.stringify(data, null, 2));
                        console.log('🔄 Status de cliente atualizado:', data);
                        
                        // Atualizar status do cliente na lista de contatos
                        setContacts(prevContacts => {
                            return prevContacts.map(contact => {
                                if (contact.phoneNumber === data.phoneNumber) {
                                    console.log('✅ Atualizando status: ' + (contact.name || contact.phoneNumber) + ' → ' + data.newStatus);
                                    return {
                                        ...contact,
                                        crmData: {
                                            ...contact.crmData,
                                            status: data.newStatus,
                                            lastContact: data.timestamp,
                                            updatedAt: data.timestamp
                                        }
                                    };
                                }
                                return contact;
                            });
                        });
                        
                        // Forçar re-renderização das colunas incrementando contador
                        setStatusUpdateCounter(prev => prev + 1);
                        console.log('🔄 Status atualizado - incrementando contador de re-renderização');
                        
                        // Mostrar notificação visual
                        const notification = document.createElement('div');
                        notification.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #10B981; color: white; padding: 12px 16px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); z-index: 1000; font-size: 14px; max-width: 300px;';
                        notification.innerHTML = '🤖 Status atualizado via n8n<br/>📱 ' + data.phoneNumber + '<br/>✅ ' + data.newStatus.toUpperCase() + (data.reason ? '<br/>📝 ' + data.reason : '');
                        document.body.appendChild(notification);
                        
                        // Remover notificação após 5 segundos
                        setTimeout(() => {
                            if (notification.parentNode) {
                                notification.parentNode.removeChild(notification);
                            }
                        }, 5000);
                    };
                    
                    socket.current.on('client-status-updated', handleClientStatusUpdated);
                    
                    // Listener de teste genérico para debugar
                    socket.current.onAny((eventName, ...args) => {
                        if (eventName === 'client-status-updated') {
                            console.log('🔥🔥🔥 EVENTO client-status-updated CAPTURADO:', eventName, args);
                        } else {
                            console.log('🔊 SOCKET EVENT RECEBIDO:', eventName, args);
                        }
                    });
                    
                    // Teste de conexão visual
                    socket.current.on('connect', () => {
                        console.log('✅ SOCKET CONECTADO - Pronto para receber eventos!');
                        // Criar notificação visual de conexão
                        const notification = document.createElement('div');
                        notification.style.cssText = 'position: fixed; top: 20px; left: 20px; background: #059669; color: white; padding: 8px 12px; border-radius: 6px; z-index: 9999; font-size: 12px;';
                        notification.innerHTML = '✅ Socket Conectado';
                        document.body.appendChild(notification);
                        setTimeout(() => {
                            if (notification.parentNode) {
                                notification.parentNode.removeChild(notification);
                            }
                        }, 3000);
                    });
                    
                    socket.current.on('disconnect', () => {
                        console.log('❌ SOCKET DESCONECTADO');
                        // Criar notificação visual de desconexão
                        const notification = document.createElement('div');
                        notification.style.cssText = 'position: fixed; top: 20px; left: 20px; background: #DC2626; color: white; padding: 8px 12px; border-radius: 6px; z-index: 9999; font-size: 12px;';
                        notification.innerHTML = '❌ Socket Desconectado';
                        document.body.appendChild(notification);
                        setTimeout(() => {
                            if (notification.parentNode) {
                                notification.parentNode.removeChild(notification);
                            }
                        }, 3000);
                    });
                    
                    return () => {
                        if (socket.current) {
                            socket.current.off('new-message', handleNewMessage);
                            socket.current.off('new-contact');
                            socket.current.off('conversation-cleared', handleConversationCleared);
                            socket.current.off('conversations-cleared', handleAllConversationsCleared);
                            socket.current.off('client-status-updated', handleClientStatusUpdated);
                        }
                    };
                }, []);
                
                // UseEffect removido - scroll agora é controlado manualmente na função sendMessage
                // para evitar scroll automático indesejado
                
                // useEffect(() => {
                //     if (messages.length > 0) {
                //         // Delay para garantir que o DOM seja renderizado
                //         setTimeout(() => {
                //     scrollToBottom();
                //         }, 100);
                //     }
                // }, [messages]); // REMOVIDO - sem rolagem automática
                
                // Fechar emoji picker ao clicar fora
                useEffect(() => {
                    const handleClickOutside = (event) => {
                        if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) {
                            setShowEmojiPicker(false);
                        }
                    };
                    
                    if (showEmojiPicker) {
                        document.addEventListener('mousedown', handleClickOutside);
                        return () => document.removeEventListener('mousedown', handleClickOutside);
                    }
                }, [showEmojiPicker]);
                
                const scrollToBottom = () => {
                    if (messagesEndRef.current) {
                        try {
                            messagesEndRef.current.scrollIntoView({ 
                                behavior: "instant",
                                block: "end",
                                inline: "nearest"
                            });
                        } catch (error) {
                            // Fallback para browsers mais antigos
                            messagesEndRef.current.scrollTop = messagesEndRef.current.scrollHeight;
                        }
                    }
                };
                
                const loadStatus = async () => {
                    try {
                        const response = await fetch('/api/status');
                        const data = await response.json();
                        setIsConnected(data.isConnected);
                        if (data.qrCode) {
                            setQrCode(data.qrCode);
                        }
                    } catch (error) {
                        console.error('Erro ao carregar status:', error);
                    }
                };
                
                const loadContacts = async () => {
                    try {
                        setLoadingContacts(true);
                        console.log('🚀 Iniciando carregamento otimizado de contatos...');
                        const startTime = Date.now();
                        
                        const response = await fetch('/api/contacts-with-crm');
                        const data = await response.json();
                        
                        if (data.success) {
                            console.log('⚡ ULTRA-RÁPIDO - Contatos carregados em ' + (Date.now() - startTime) + 'ms:', {
                                total: data.stats ? data.stats.totalContacts : data.contacts.length,
                                withCRM: data.stats ? data.stats.withCRM : 0,
                                serverTime: data.stats ? data.stats.loadTime : 0,
                                isLimited: data.stats ? data.stats.isLimited : false
                            });
                            setContacts(data.contacts);
                            
                            // Mostrar aviso se carregamento foi limitado
                            if (data.stats && data.stats.isLimited) {
                                console.log('📊 Carregados 50 contatos mais recentes para velocidade máxima');
                            }
                        } else {
                            console.warn('⚠️ Erro ao carregar contatos:', data.message);
                            setContacts([]);
                        }
                    } catch (error) {
                        console.error('❌ Erro ao carregar contatos:', error);
                        setContacts([]);
                    } finally {
                        setLoadingContacts(false);
                    }
                };
                
                const loadMessages = async (phoneNumber) => {
                    try {
                        const response = await fetch('/api/messages/' + phoneNumber);
                        const data = await response.json();
                        setMessages(data.messages || []);
                        
                        await fetch('/api/contacts/' + phoneNumber + '/read', { method: 'POST' });
                    } catch (error) {
                        console.error('Erro ao carregar mensagens:', error);
                    }
                };
                
                const selectContact = async (contact) => {
                    // Verificar se já existe um chat aberto para este contato
                    const existingChat = openChats.find(chat => chat.contact.phoneNumber === contact.phoneNumber);
                    if (existingChat) {
                        // Se já existe, trazer para frente e focar
                        const updatedChats = openChats.map(chat => ({
                            ...chat,
                            zIndex: chat.contact.phoneNumber === contact.phoneNumber ? 1000 : Math.max(900, chat.zIndex - 1)
                        }));
                        setOpenChats(updatedChats);
                        return;
                    }
                    
                    // Criar um novo chat popup
                    const chatId = Date.now();
                    const newChat = {
                        id: chatId,
                        contact: contact,
                        messages: [],
                        loading: false,
                        newMessage: '',
                        selectedFile: null,
                        clientData: null,
                        loadingClient: false,
                        showCRM: false,
                        crmForm: {},
                        newNote: '',
                        savingCRM: false,
                        addingNote: false,
                        showEmojiPicker: false,
                        // Campos para gravação de áudio
                        isRecording: false,
                        recordingStartTime: null,
                        mediaRecorder: null,
                        uploading: false,
                        position: {
                            x: 100 + (openChats.length * 50), // Offset para não sobrepor
                            y: 100 + (openChats.length * 30)
                        },
                        zIndex: 1000,
                        isDragging: false
                    };
                    
                    setOpenChats(prev => [...prev, newChat]);
                    
                    // Carregar dados do chat
                    loadChatData(chatId, contact.phoneNumber);
                    
                    // Marcar mensagens como lidas se houver mensagens não lidas
                    if (contact.unreadCount > 0) {
                        try {
                            await fetch('/api/contacts/' + contact.phoneNumber + '/read', { 
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' }
                            });
                            console.log('✅ Mensagens marcadas como lidas');
                        } catch (error) {
                            console.error('❌ Erro ao marcar mensagens como lidas:', error);
                        }
                    }
                };

                const closeChatPopup = (chatId) => {
                    setOpenChats(prev => prev.filter(chat => chat.id !== chatId));
                };

                const updateChatData = (chatId, updates) => {
                    setOpenChats(prev => prev.map(chat => 
                        chat.id === chatId ? { ...chat, ...updates } : chat
                    ));
                };

                const loadChatData = async (chatId, phoneNumber) => {
                    updateChatData(chatId, { loading: true });
                    
                    try {
                        // Carregar mensagens
                        const messagesResponse = await fetch(\`/api/messages/\${phoneNumber}\`);
                        const messagesData = await messagesResponse.json();
                        
                        // Carregar dados do cliente
                        const clientResponse = await fetch(\`/api/client/\${phoneNumber}\`);
                        const clientData = clientResponse.ok ? await clientResponse.json() : null;
                        
                        updateChatData(chatId, {
                            messages: messagesData.messages || [],
                            clientData: clientData,
                            loading: false,
                            loadingClient: false
                        });
                        
                        // Scroll automático para o final ao abrir conversa
                        setTimeout(() => {
                            const chatContainer = messagesContainerRefs.current[chatId];
                            if (chatContainer) {
                                chatContainer.scrollTop = chatContainer.scrollHeight;
                            }
                        }, 100);
                        
                    } catch (error) {
                        console.error('Erro ao carregar dados do chat:', error);
                        updateChatData(chatId, { loading: false, loadingClient: false });
                    }
                };

                const bringChatToFront = (chatId) => {
                    setOpenChats(prev => prev.map(chat => ({
                        ...chat,
                        zIndex: chat.id === chatId ? 1000 : Math.max(900, chat.zIndex - 1)
                    })));
                };

                const startDrag = (chatId, e) => {
                    e.preventDefault();
                    const chat = openChats.find(c => c.id === chatId);
                    if (!chat) return;
                    
                    bringChatToFront(chatId);
                    updateChatData(chatId, { isDragging: true });
                    
                    const startX = e.clientX - chat.position.x;
                    const startY = e.clientY - chat.position.y;
                    
                    const handleMouseMove = (e) => {
                        const newX = Math.max(0, Math.min(window.innerWidth - 300, e.clientX - startX));
                        const newY = Math.max(0, Math.min(window.innerHeight - 200, e.clientY - startY));
                        
                        updateChatData(chatId, {
                            position: { x: newX, y: newY }
                        });
                    };
                    
                    const handleMouseUp = () => {
                        updateChatData(chatId, { isDragging: false });
                        document.removeEventListener('mousemove', handleMouseMove);
                        document.removeEventListener('mouseup', handleMouseUp);
                    };
                    
                    document.addEventListener('mousemove', handleMouseMove);
                    document.addEventListener('mouseup', handleMouseUp);
                };
                
                const sendMessage = async (chatId, e) => {
                    e.preventDefault();
                    const chat = openChats.find(c => c.id === chatId);
                    if (!chat || (!chat.newMessage.trim() && !chat.selectedFile) || chat.loading) return;
                    
                    updateChatData(chatId, { loading: true });
                    
                    try {
                        let response;
                        
                        // Se há arquivo selecionado, enviar com arquivo
                        if (chat.selectedFile) {
                            response = await fetch('/api/send-message', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    phoneNumber: chat.contact.phoneNumber,
                                    message: chat.newMessage,
                                    fileUrl: chat.selectedFile.url,
                                    fileType: chat.selectedFile.type?.startsWith('audio/') ? 'ptt' : 'file'
                                })
                            });
                        } else {
                            // Enviar apenas mensagem de texto
                            response = await fetch('/api/send-message', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    phoneNumber: chat.contact.phoneNumber,
                                    message: chat.newMessage
                                })
                            });
                        }
                        
                        if (response.ok) {
                            // Capturar posição atual do scroll antes de adicionar mensagem
                            const chatContainer = messagesContainerRefs.current[chatId];
                            const wasNearBottom = chatContainer ? 
                                (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 100) : true;
                            const currentScrollTop = chatContainer ? chatContainer.scrollTop : 0;
                            
                            // Adicionar mensagem imediatamente para feedback visual instantâneo
                            const tempMessage = {
                                _id: 'temp-' + Date.now(),
                                messageId: 'temp-' + Date.now(),
                                body: chat.newMessage,
                                type: chat.selectedFile ? (chat.selectedFile.type?.startsWith('audio/') ? 'audio' : 'document') : 'text',
                                mediaUrl: chat.selectedFile?.url || null,
                                isFromMe: true,
                                timestamp: new Date().toISOString()
                            };
                            
                            updateChatData(chatId, { 
                                newMessage: '',
                                selectedFile: null,
                                loading: false,
                                messages: [...chat.messages, tempMessage]
                            });
                            
                            // Restaurar posição do scroll após adicionar mensagem
                            setTimeout(() => {
                                if (chatContainer) {
                                    if (wasNearBottom) {
                                        // Se estava próximo do final, fazer scroll suave para o final
                                        chatContainer.scrollTop = chatContainer.scrollHeight;
                                    } else {
                                        // Se estava no meio, manter posição original
                                        chatContainer.scrollTop = currentScrollTop;
                                    }
                                }
                            }, 0);
                            
                            console.log('✅ Mensagem enviada, adicionada temporariamente à interface');
                        } else {
                            const errorData = await response.json();
                            throw new Error(errorData.message || 'Erro ao enviar mensagem');
                        }
                    } catch (error) {
                        console.error('Erro ao enviar mensagem:', error);
                        updateChatData(chatId, { loading: false });
                        alert('Erro ao enviar mensagem: ' + error.message);
                    }
                };

                // Função para salvar dados do CRM
                const saveCRMData = async (chatId) => {
                    const chat = openChats.find(c => c.id === chatId);
                    if (!chat) return;
                    
                    updateChatData(chatId, { savingCRM: true });
                    
                    try {
                        // CORREÇÃO: Enviar todos os dados disponíveis (do formulário + dados existentes do cliente)
                        const existingClient = chat.clientData?.client || {};
                        const formData = chat.crmForm || {};
                        
                        // Merge de dados do formulário com dados existentes
                        const dataToSave = {
                            name: formData.name || existingClient.name || chat.contact.name,
                            email: formData.email !== undefined ? formData.email : (existingClient.email || ''),
                            company: formData.company !== undefined ? formData.company : (existingClient.company || ''),
                            position: formData.position !== undefined ? formData.position : (existingClient.position || ''),
                            address: formData.address !== undefined ? formData.address : (existingClient.address || ''),
                            city: formData.city !== undefined ? formData.city : (existingClient.city || ''),
                            state: formData.state !== undefined ? formData.state : (existingClient.state || ''),
                            zipCode: formData.zipCode !== undefined ? formData.zipCode : (existingClient.zipCode || ''),
                            birthDate: formData.birthDate !== undefined ? formData.birthDate : existingClient.birthDate,
                            tags: formData.tags !== undefined ? formData.tags : existingClient.tags,
                            status: formData.status || existingClient.status || 'novo',
                            priority: formData.priority || existingClient.priority || 'normal',
                            source: formData.source !== undefined ? formData.source : (existingClient.source || 'whatsapp'),
                            assignedTo: formData.assignedTo !== undefined ? formData.assignedTo : existingClient.assignedTo,
                            nextFollowUp: formData.nextFollowUp !== undefined ? formData.nextFollowUp : existingClient.nextFollowUp,
                            value: parseFloat(formData.value) || existingClient.dealValue || 0,
                            dealStage: formData.dealStage !== undefined ? formData.dealStage : (existingClient.dealStage || 'prospecting'),
                            customFields: formData.customFields !== undefined ? formData.customFields : existingClient.customFields,
                            phoneNumber: chat.contact.phoneNumber
                        };
                        
                        console.log('📝 Dados completos sendo enviados para salvar:', JSON.stringify(dataToSave, null, 2));
                        
                        const response = await fetch('/api/client/' + chat.contact.phoneNumber, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(dataToSave)
                        });
                        
                        if (response.ok) {
                            const responseData = await response.json();
                            console.log('✅ Resposta do servidor:', responseData);
                            
                            // Atualizar dados do cliente no chat com a resposta do servidor
                            updateChatData(chatId, { 
                                clientData: { client: responseData.client },
                                savingCRM: false
                            });
                            
                            // Atualizar a lista de contatos em tempo real com dados reais do servidor
                            setContacts(prevContacts => prevContacts.map(contact => 
                                contact.phoneNumber === chat.contact.phoneNumber 
                                    ? { 
                                        ...contact, 
                                        name: responseData.client.name,
                                        crmData: {
                                            ...responseData.client
                                        }
                                    }
                                    : contact
                            ));
                            
                            // Forçar atualização das colunas após salvar
                            forceColumnUpdate();
                            
                            console.log('✅ Dados do CRM salvos com sucesso e interface atualizada com dados reais do servidor');
                        } else {
                            const errorData = await response.json();
                            throw new Error(errorData.message || 'Erro ao salvar dados');
                        }
                    } catch (error) {
                        console.error('Erro ao salvar CRM:', error);
                        updateChatData(chatId, { savingCRM: false });
                        alert('Erro ao salvar dados do cliente');
                    }
                };

                // Função para adicionar nota no chat
                const addChatNote = async (chatId) => {
                    console.log('🔥 addChatNote chamada para chatId:', chatId);
                    const chat = openChats.find(c => c.id === chatId);
                    console.log('🔥 Chat encontrado:', !!chat);
                    console.log('🔥 Nota para adicionar:', chat?.newNote);
                    
                    if (!chat || !chat.newNote?.trim()) {
                        console.log('🔥 Saindo - sem chat ou nota vazia');
                        return;
                    }
                    
                    updateChatData(chatId, { addingNote: true });
                    
                    try {
                        console.log('🔥 Enviando requisição para adicionar nota...');
                        const response = await fetch('/api/client/' + chat.contact.phoneNumber + '/note', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                text: chat.newNote,
                                timestamp: new Date().toISOString()
                            })
                        });
                        
                        console.log('🔥 Resposta da API:', response.status, response.ok);
                        
                        if (response.ok) {
                            // Recarregar dados do cliente para mostrar nova nota
                            await loadChatData(chatId, chat.contact.phoneNumber);
                            updateChatData(chatId, { 
                                addingNote: false,
                                newNote: '' // Limpar campo de nota
                            });
                            console.log('✅ Nota adicionada com sucesso');
                        } else {
                            const errorData = await response.json();
                            console.log('🔥 Erro da API:', errorData);
                            throw new Error('Erro ao adicionar nota');
                        }
                    } catch (error) {
                        console.error('🔥 Erro ao adicionar nota:', error);
                        updateChatData(chatId, { addingNote: false });
                        alert('Erro ao adicionar nota');
                    }
                };

                // Função para editar nota existente
                const editChatNote = async (chatId, noteIndex) => {
                    const chat = openChats.find(c => c.id === chatId);
                    if (!chat || !chat.clientData?.client?.notes?.[noteIndex]) return;
                    
                    const noteToEdit = chat.clientData.client.notes[noteIndex];
                    const newText = prompt('Editar nota:', noteToEdit.text);
                    
                    if (newText === null || newText.trim() === noteToEdit.text) return;
                    
                    if (!newText.trim()) {
                        if (!confirm('Deseja excluir esta nota?')) return;
                    }
                    
                    updateChatData(chatId, { editingNote: true });
                    
                    try {
                        const response = await fetch('/api/client/' + chat.contact.phoneNumber + '/note/' + noteIndex, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                text: newText.trim(),
                                updatedAt: new Date().toISOString()
                            })
                        });
                        
                        if (response.ok) {
                            // Recarregar dados do cliente para mostrar nota editada
                            await loadChatData(chatId, chat.contact.phoneNumber);
                            updateChatData(chatId, { editingNote: false });
                            console.log('✅ Nota editada com sucesso');
                        } else {
                            throw new Error('Erro ao editar nota');
                        }
                    } catch (error) {
                        console.error('Erro ao editar nota:', error);
                        updateChatData(chatId, { editingNote: false });
                        alert('Erro ao editar nota');
                    }
                };

                // Função para excluir nota
                const deleteChatNote = async (chatId, noteIndex) => {
                    const chat = openChats.find(c => c.id === chatId);
                    if (!chat || !chat.clientData?.client?.notes?.[noteIndex]) return;
                    
                    if (!confirm('Deseja realmente excluir esta nota?')) return;
                    
                    updateChatData(chatId, { deletingNote: true });
                    
                    try {
                        const response = await fetch('/api/client/' + chat.contact.phoneNumber + '/note/' + noteIndex, {
                            method: 'DELETE'
                        });
                        
                        if (response.ok) {
                            // Recarregar dados do cliente para remover nota
                            await loadChatData(chatId, chat.contact.phoneNumber);
                            updateChatData(chatId, { deletingNote: false });
                            console.log('✅ Nota excluída com sucesso');
                        } else {
                            throw new Error('Erro ao excluir nota');
                        }
                    } catch (error) {
                        console.error('Erro ao excluir nota:', error);
                        updateChatData(chatId, { deletingNote: false });
                        alert('Erro ao excluir nota');
                    }
                };

                // Função para formatar valor monetário
                const formatCurrency = (value) => {
                    if (!value || value === 0) return '';
                    
                    // Se o valor for menor que 1000, mostrar valor completo
                    if (value < 1000) {
                        return 'R$ ' + value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    }
                    
                    // Se o valor for entre 1000 e 999999, mostrar em milhares com uma casa decimal se necessário
                    if (value < 1000000) {
                        const thousands = value / 1000;
                        if (thousands % 1 === 0) {
                            return 'R$ ' + thousands.toFixed(0) + 'k';
                        } else {
                            return 'R$ ' + thousands.toFixed(1) + 'k';
                        }
                    }
                    
                    // Se o valor for maior que 1 milhão, mostrar em milhões
                    const millions = value / 1000000;
                    if (millions % 1 === 0) {
                        return 'R$ ' + millions.toFixed(0) + 'M';
                    } else {
                        return 'R$ ' + millions.toFixed(1) + 'M';
                    }
                };

                // Função para definir cores de prioridade
                const getPriorityColor = (priority) => {
                    switch (priority) {
                        case 'urgent':
                            return 'bg-red-100 text-red-800 border-red-200';
                        case 'high':
                            return 'bg-orange-100 text-orange-800 border-orange-200';
                        case 'medium':
                            return 'bg-yellow-100 text-yellow-800 border-yellow-200';
                        case 'low':
                            return 'bg-gray-100 text-gray-800 border-gray-200';
                        default:
                            return 'bg-gray-100 text-gray-800 border-gray-200';
                    }
                };

                // Função para definir cores de status
                const getStatusColor = (status) => {
                    switch (status) {
                        case 'novo':
                            return 'bg-yellow-100 text-yellow-800';
                        case 'andamento':
                            return 'bg-blue-100 text-blue-800';
                        case 'aprovado':
                        case 'client':
                            return 'bg-green-100 text-green-800';
                        case 'reprovado':
                        case 'inactive':
                        case 'blocked':
                            return 'bg-red-100 text-red-800';
                        default:
                            return 'bg-gray-100 text-gray-800';
                    }
                };

                const formatTime = (date) => {
                    return new Date(date).toLocaleTimeString('pt-BR', {
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                };
                
                const formatDate = (date) => {
                    if (!date) return 'N/A';
                    
                    const today = new Date();
                    const messageDate = new Date(date);
                    
                    if (messageDate.toDateString() === today.toDateString()) {
                        return 'Hoje';
                    }
                    
                    const yesterday = new Date(today);
                    yesterday.setDate(yesterday.getDate() - 1);
                    
                    if (messageDate.toDateString() === yesterday.toDateString()) {
                        return 'Ontem';
                    }
                    
                    return messageDate.toLocaleDateString('pt-BR');
                };
                
                const filteredContacts = contacts.filter(contact => {
                    // Filtro por termo de busca
                    const matchesSearch = contact.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                                        contact.phoneNumber.includes(searchTerm);
                    
                    if (!matchesSearch) return false;
                    
                    // Se não há dados do CRM, mostrar apenas se não há filtros ativos
                    if (!contact.crmData) {
                        return !crmFilters.status && !crmFilters.priority && !crmFilters.minValue && !crmFilters.maxValue;
                    }
                    
                    // Filtros do CRM
                    if (crmFilters.status && contact.crmData.status !== crmFilters.status) return false;
                    if (crmFilters.priority && contact.crmData.priority !== crmFilters.priority) return false;
                    
                    // Filtro por valor
                    const dealValue = contact.crmData.dealValue || 0;
                    if (crmFilters.minValue && dealValue < parseFloat(crmFilters.minValue)) return false;
                    if (crmFilters.maxValue && dealValue > parseFloat(crmFilters.maxValue)) return false;
                    
                    return true;
                });
                
                // Agrupar contatos por status para organização em colunas - otimizado com useMemo
                const contactsByStatus = React.useMemo(() => {
                    console.log('🔄 Reagrupando contatos por status (contador:', statusUpdateCounter, ')');
                    return {
                    'novo': filteredContacts
                        .filter(c => !c.crmData || c.crmData.status === 'novo')
                        .sort((a, b) => new Date(b.lastMessageTime || 0) - new Date(a.lastMessageTime || 0)),
                    'andamento': filteredContacts
                        .filter(c => c.crmData && c.crmData.status === 'andamento')
                        .sort((a, b) => new Date(b.lastMessageTime || 0) - new Date(a.lastMessageTime || 0)),
                    'aprovado': filteredContacts
                        .filter(c => c.crmData && (c.crmData.status === 'aprovado' || c.crmData.status === 'client'))
                        .sort((a, b) => new Date(b.lastMessageTime || 0) - new Date(a.lastMessageTime || 0)),
                    'reprovado': filteredContacts
                        .filter(c => c.crmData && (c.crmData.status === 'reprovado' || c.crmData.status === 'inactive' || c.crmData.status === 'blocked'))
                        .sort((a, b) => new Date(b.lastMessageTime || 0) - new Date(a.lastMessageTime || 0))
                };
                }, [filteredContacts, statusUpdateCounter]); // Dependência do contador para forçar re-renderização
                
                const statusConfig = React.useMemo(() => ({
                    'novo': { title: '🆕 Novo Cliente', color: 'border-yellow-300 bg-yellow-50', count: contactsByStatus.novo.length },
                    'andamento': { title: '⏳ Em Andamento', color: 'border-blue-300 bg-blue-50', count: contactsByStatus.andamento.length },
                    'aprovado': { title: '✅ Aprovado', color: 'border-green-300 bg-green-50', count: contactsByStatus.aprovado.length },
                    'reprovado': { title: '❌ Reprovado', color: 'border-red-300 bg-red-50', count: contactsByStatus.reprovado.length }
                }), [contactsByStatus]);
                
                // Função para lidar com seleção de emoji
                const handleEmojiSelect = (emoji) => {
                    setNewMessage(prev => prev + emoji.unicode);
                    setShowEmojiPicker(false);
                };
                
                // Lista de emojis mais usados
                const frequentEmojis = ['😀', '😂', '😊', '😍', '🥰', '😘', '😋', '😎', '🤗', '🤔', '😴', '😅', '🙄', '😇', '🤗', '👍', '👎', '👏', '🙏', '💪', '✌️', '🤞', '👌', '🎉', '🎊', '💕', '❤️', '💖', '💝', '🌹', '🌺', '⭐', '🌟', '✨', '🔥', '💯'];
                
                // Função para adicionar emoji rápido
                const addQuickEmoji = (emoji) => {
                    setNewMessage(prev => prev + emoji);
                };
                
                // Detectar emojis nas mensagens
                const formatMessageWithEmojis = (text) => {
                    if (!text) return '';
                    return text;
                };
                
                // Função para lidar com seleção de arquivo
                const handleFileSelect = async (chatId, event) => {
                    const file = event.target.files[0];
                    if (!file) return;
                    
                    // Verificar tamanho do arquivo (máximo 64MB para WhatsApp)
                    const maxSize = 64 * 1024 * 1024; // 64MB
                    if (file.size > maxSize) {
                        alert('Arquivo muito grande! O WhatsApp aceita arquivos de até 64MB.');
                        return;
                    }
                    
                    updateChatData(chatId, { uploading: true });
                    
                    try {
                        const formData = new FormData();
                        formData.append('file', file);
                        
                        const response = await fetch('/api/upload', {
                            method: 'POST',
                            body: formData
                        });
                        
                        if (response.ok) {
                            const result = await response.json();
                            updateChatData(chatId, { 
                                selectedFile: {
                                    name: result.file.originalName,
                                    url: result.file.url,
                                    type: result.file.mimetype,
                                    size: result.file.size
                                },
                                uploading: false 
                            });
                            console.log('✅ Arquivo enviado com sucesso:', result.file.originalName);
                        } else {
                            throw new Error('Erro no upload do arquivo');
                        }
                    } catch (error) {
                        console.error('Erro no upload:', error);
                        updateChatData(chatId, { uploading: false });
                        alert('Erro ao fazer upload do arquivo: ' + error.message);
                    }
                    
                    // Limpar o input para permitir selecionar o mesmo arquivo novamente
                    event.target.value = '';
                };
                
                // Função para remover arquivo selecionado
                const removeSelectedFile = (chatId) => {
                    updateChatData(chatId, { selectedFile: null });
                };
                
                // Função para alternar picker de emoji
                const toggleEmojiPicker = (chatId) => {
                    const chat = openChats.find(c => c.id === chatId);
                    updateChatData(chatId, { showEmojiPicker: !chat.showEmojiPicker });
                };
                
                // Função para adicionar emoji à mensagem
                const addEmojiToMessage = (chatId, emoji) => {
                    const chat = openChats.find(c => c.id === chatId);
                    updateChatData(chatId, { 
                        newMessage: (chat.newMessage || '') + emoji,
                        showEmojiPicker: false 
                    });
                };

                // ========== FUNÇÕES DE GRAVAÇÃO DE ÁUDIO ==========
                
                // Função para iniciar/parar gravação de áudio
                const toggleAudioRecording = async (chatId) => {
                    const chat = openChats.find(c => c.id === chatId);
                    if (!chat) return;
                    
                    if (chat.isRecording) {
                        await stopAudioRecording(chatId);
                    } else {
                        await startAudioRecording(chatId);
                    }
                };

                // Função para iniciar gravação
                const startAudioRecording = async (chatId) => {
                    try {
                        console.log('🎙️ Iniciando gravação para chat:', chatId);
                        
                        const stream = await navigator.mediaDevices.getUserMedia({ 
                            audio: {
                                echoCancellation: true,
                                noiseSuppression: true,
                                autoGainControl: true,
                                sampleRate: 44100,
                                channelCount: 1
                            }
                        });
                        
                        // Usar formato mais compatível
                        let mimeType = 'audio/webm;codecs=opus';
                        if (MediaRecorder.isTypeSupported('audio/webm')) {
                            mimeType = 'audio/webm';
                        }
                        
                        const mediaRecorder = new MediaRecorder(stream, { 
                            mimeType,
                            audioBitsPerSecond: 128000
                        });
                        
                        const audioChunks = [];
                        const recordingStartTime = Date.now();
                        
                        mediaRecorder.ondataavailable = (event) => {
                            if (event.data.size > 0) {
                                audioChunks.push(event.data);
                            }
                        };
                        
                        mediaRecorder.onstop = async () => {
                            console.log('🎙️ Gravação finalizada para chat:', chatId);
                            
                            // Criar blob com formato WebM
                            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                            
                            // Fazer upload automático
                            await uploadChatAudio(chatId, audioBlob);
                            
                            // Parar todas as tracks do stream
                            stream.getTracks().forEach(track => track.stop());
                            
                            updateChatData(chatId, {
                                isRecording: false,
                                mediaRecorder: null,
                                recordingStartTime: null
                            });
                        };
                        
                        // Iniciar gravação
                        mediaRecorder.start(1000);
                        
                        // Atualizar estado do chat
                        updateChatData(chatId, {
                            isRecording: true,
                            mediaRecorder: mediaRecorder,
                            recordingStartTime: recordingStartTime
                        });
                        
                        console.log('✅ Gravação iniciada com sucesso');
                        
                    } catch (error) {
                        console.error('❌ Erro ao iniciar gravação:', error);
                        
                        if (error.name === 'NotAllowedError') {
                            alert('🎙️ Permissão negada para usar o microfone. Permita o acesso e tente novamente.');
                        } else if (error.name === 'NotFoundError') {
                            alert('🎙️ Nenhum microfone encontrado. Conecte um microfone e tente novamente.');
                        } else {
                            alert('🎙️ Erro ao acessar o microfone: ' + error.message);
                        }
                    }
                };

                // Função para parar gravação
                const stopAudioRecording = async (chatId) => {
                    const chat = openChats.find(c => c.id === chatId);
                    if (!chat || !chat.mediaRecorder) return;
                    
                    if (chat.mediaRecorder.state === 'recording') {
                        chat.mediaRecorder.stop();
                    }
                };

                // Função para upload do áudio gravado
                const uploadChatAudio = async (chatId, audioBlob) => {
                    try {
                        console.log('📤 Fazendo upload do áudio gravado...');
                        
                        // Converter para WAV se necessário
                        let finalBlob = audioBlob;
                        let fileName = 'gravacao_' + Date.now() + '.webm';
                        let mimeType = 'audio/webm';
                        
                        try {
                            // Tentar converter para WAV para melhor compatibilidade
                            const wavBlob = await convertWebMToWav(audioBlob);
                            if (wavBlob) {
                                finalBlob = wavBlob;
                                fileName = 'gravacao_' + Date.now() + '.wav';
                                mimeType = 'audio/wav';
                                console.log('✅ Áudio convertido para WAV');
                            }
                        } catch (conversionError) {
                            console.log('⚠️ Falha na conversão, usando WebM original:', conversionError.message);
                        }
                        
                        const formData = new FormData();
                        const file = new File([finalBlob], fileName, { type: mimeType });
                        formData.append('file', file);
                        
                        const response = await fetch('/api/upload', {
                            method: 'POST',
                            body: formData
                        });
                        
                        if (response.ok) {
                            const result = await response.json();
                            updateChatData(chatId, { 
                                selectedFile: {
                                    name: result.file.originalName,
                                    url: result.file.url,
                                    type: result.file.mimetype,
                                    size: result.file.size
                                }
                            });
                            console.log('✅ Áudio gravado enviado com sucesso:', result.file.originalName);
                        } else {
                            throw new Error('Erro no upload do arquivo');
                        }
                    } catch (error) {
                        console.error('❌ Erro no upload do áudio:', error);
                        alert('Erro ao fazer upload do áudio: ' + error.message);
                    }
                };

                // Função para converter WebM para WAV
                const convertWebMToWav = async (webmBlob) => {
                    try {
                        const arrayBuffer = await webmBlob.arrayBuffer();
                        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                        
                        // Decodificar o áudio WebM
                        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                        
                        // Converter para WAV
                        const wavBuffer = audioBufferToWav(audioBuffer);
                        return new Blob([wavBuffer], { type: 'audio/wav' });
                        
                    } catch (error) {
                        console.error('❌ Erro na conversão WebM->WAV:', error);
                        throw error;
                    }
                };

                // Função para converter AudioBuffer para WAV
                const audioBufferToWav = (buffer) => {
                    const length = buffer.length;
                    const numberOfChannels = buffer.numberOfChannels;
                    const sampleRate = buffer.sampleRate;
                    
                    const arrayBuffer = new ArrayBuffer(44 + length * numberOfChannels * 2);
                    const view = new DataView(arrayBuffer);
                    
                    // Escrever header WAV
                    const writeString = (offset, string) => {
                        for (let i = 0; i < string.length; i++) {
                            view.setUint8(offset + i, string.charCodeAt(i));
                        }
                    };
                    
                    writeString(0, 'RIFF');
                    view.setUint32(4, 36 + length * numberOfChannels * 2, true);
                    writeString(8, 'WAVE');
                    writeString(12, 'fmt ');
                    view.setUint32(16, 16, true);
                    view.setUint16(20, 1, true);
                    view.setUint16(22, numberOfChannels, true);
                    view.setUint32(24, sampleRate, true);
                    view.setUint32(28, sampleRate * numberOfChannels * 2, true);
                    view.setUint16(32, numberOfChannels * 2, true);
                    view.setUint16(34, 16, true);
                    writeString(36, 'data');
                    view.setUint32(40, length * numberOfChannels * 2, true);
                    
                    // Converter dados de áudio
                    let offset = 44;
                    for (let i = 0; i < length; i++) {
                        for (let channel = 0; channel < numberOfChannels; channel++) {
                            const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
                            view.setInt16(offset, sample * 0x7FFF, true);
                            offset += 2;
                        }
                    }
                    
                    return arrayBuffer;
                };
                
                // Função de gravação de áudio removida conforme solicitado
                
                // Função de upload de áudio removida
                
                // Função para formatar tamanho de arquivo
                const formatFileSize = (bytes) => {
                    if (bytes === 0) return '0 Bytes';
                    const k = 1024;
                    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
                    const i = Math.floor(Math.log(bytes) / Math.log(k));
                    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                };

                

                
                const loadReports = async () => {
                    try {
                        const response = await fetch('/api/crm/reports');
                        const data = await response.json();
                        if (data.success) {
                            setReportData(data.stats);
                            setShowReports(true);
                        }
                    } catch (error) {
                        console.error('❌ Erro ao carregar relatórios:', error);
                    }
                };
                
                // Função para limpar conversa atual
                const clearCurrentConversation = async () => {
                    if (!selectedContact) {
                        alert('⚠️ Selecione uma conversa primeiro');
                        return;
                    }
                    
                    const confirmed = confirm(\`🗑️ Tem certeza que deseja limpar todas as mensagens da conversa com \${selectedContact.name}?\n\nEsta ação não pode ser desfeita.\`);
                    if (!confirmed) return;
                    
                    try {
                        const response = await fetch('/api/messages/clear', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phoneNumber: selectedContact.phoneNumber })
                        });
                        
                        const data = await response.json();
                        if (data.success) {
                            alert(\`✅ \${data.message}\`);
                            setMessages([]); // Limpar mensagens da interface
                            console.log(\`🗑️ Conversa com \${selectedContact.name} foi limpa\`);
                        } else {
                            alert(\`❌ Erro: \${data.message}\`);
                        }
                    } catch (error) {
                        console.error('❌ Erro ao limpar conversa:', error);
                        alert('❌ Erro ao limpar conversa: ' + error.message);
                    }
                };
                
                // Função para limpar todas as conversas
                const clearAllConversations = async () => {
                    const confirmed = confirm(\`🗑️ ATENÇÃO: Tem certeza que deseja limpar TODAS as conversas?\n\nEsta ação irá:\n• Deletar todas as mensagens de todos os contatos\n• Não pode ser desfeita\n\nDigite "CONFIRMAR" para prosseguir\`);
                    if (!confirmed) return;
                    
                    const doubleConfirm = prompt('⚠️ Para confirmar, digite "CONFIRMAR" (em maiúsculas):');
                    if (doubleConfirm !== 'CONFIRMAR') {
                        alert('❌ Operação cancelada');
                        return;
                    }
                    
                    try {
                        const response = await fetch('/api/messages/clear', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ clearAll: true })
                        });
                        
                        const data = await response.json();
                        if (data.success) {
                            alert(\`✅ \${data.message}\`);
                            setMessages([]); // Limpar mensagens da interface
                            setSelectedContact(null); // Desselecionar contato
                            console.log('🗑️ Todas as conversas foram limpas');
                        } else {
                            alert(\`❌ Erro: \${data.message}\`);
                        }
                    } catch (error) {
                        console.error('❌ Erro ao limpar todas as conversas:', error);
                        alert('❌ Erro ao limpar conversas: ' + error.message);
                    }
                };
                
                // Função para obter ícone do arquivo
                const getFileIcon = (type, filename) => {
                    const ext = filename.split('.').pop().toLowerCase();
                    
                    if (type === 'image') return '🖼️';
                    if (type === 'video') return '🎥';
                    if (type === 'audio' || type === 'ptt') return '🎵';
                    if (type === 'pdf') return '📄';
                    if (type === 'document') return '📝';
                    if (type === 'spreadsheet') return '📊';
                    if (type === 'presentation') return '📊';
                    
                    // Por extensão
                    if (['zip', 'rar', '7z'].includes(ext)) return '📦';
                    if (['txt', 'log'].includes(ext)) return '📄';
                    if (['js', 'html', 'css', 'json'].includes(ext)) return '⚡';
                    
                    return '📎';
                };
                
                return (
                    <div className="h-screen flex flex-col bg-transparent">
                        {/* Header Padronizado */}
                        <div dangerouslySetInnerHTML={{__html: \`${getStandardHeader('Chat WhatsApp', '💬', 'chat')}\`}}></div>
                        
                        {/* Filtros Horizontais */}
                        <div className="bg-white border-b border-gray-200 shadow-sm">
                            <div className="px-6 py-4">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center space-x-4">
                                    <h2 className="text-lg font-semibold text-gray-800 flex items-center">
                                        <span className="mr-2">💬</span>
                                        Conversas & CRM
                                    </h2>
                                        
                                        {/* Botão para ocultar/mostrar filtros */}
                                        <button
                                            onClick={() => setShowFilters(!showFilters)}
                                            className="filter-toggle-btn px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors flex items-center space-x-1"
                                            title={showFilters ? "Ocultar filtros" : "Mostrar filtros"}
                                        >
                                            <i className={showFilters ? 'fas fa-chevron-up' : 'fas fa-chevron-down'}></i>
                                            <span>{showFilters ? 'Ocultar' : 'Mostrar'} Filtros</span>
                                        </button>
                                    </div>
                                    
                                    {/* Estatísticas CRM na horizontal */}
                                    <div className="flex items-center space-x-4">
                                        <div className="bg-green-50 px-3 py-2 rounded-lg text-center">
                                            <div className="text-sm font-bold text-green-600">
                                                {contacts.filter(c => c.crmData?.status === 'aprovado' || c.crmData?.status === 'client').length}
                                            </div>
                                            <div className="text-xs text-green-500">✅ Aprovados</div>
                                        </div>
                                        <div className="bg-yellow-50 px-3 py-2 rounded-lg text-center">
                                            <div className="text-sm font-bold text-yellow-600">
                                                {contacts.filter(c => !c.crmData || c.crmData?.status === 'novo').length}
                                            </div>
                                            <div className="text-xs text-yellow-500">🆕 Novos</div>
                                        </div>
                                        <div className="bg-blue-50 px-3 py-2 rounded-lg text-center">
                                            <div className="text-sm font-bold text-blue-600">
                                                {contacts.filter(c => c.crmData?.status === 'andamento').length}
                                            </div>
                                            <div className="text-xs text-blue-500">⏳ Em Andamento</div>
                                        </div>
                                        <div className="bg-red-50 px-3 py-2 rounded-lg text-center">
                                            <div className="text-sm font-bold text-red-600">
                                                {contacts.filter(c => c.crmData?.status === 'reprovado' || c.crmData?.status === 'inactive' || c.crmData?.status === 'blocked').length}
                                            </div>
                                            <div className="text-xs text-red-500">❌ Reprovados</div>
                                        </div>
                                        <div className="bg-green-50 px-3 py-2 rounded-lg text-center">
                                            <div className="text-sm font-bold text-green-600">
                                                R$ {contacts.reduce((sum, c) => sum + (c.crmData?.dealValue || 0), 0).toLocaleString('pt-BR')}
                                            </div>
                                            <div className="text-xs text-green-500">💰 Pipeline</div>
                                        </div>
                                    </div>
                                </div>
                                
                                {/* Filtros e Busca em linha horizontal - Condicional */}
                                <div className={showFilters ? 'transition-all duration-300 ease-in-out overflow-hidden max-h-96 opacity-100' : 'transition-all duration-300 ease-in-out overflow-hidden max-h-0 opacity-0'}>
                                <div className="flex items-center space-x-4">
                                    {/* Campo de busca */}
                                    <div className="relative flex-1 max-w-md">
                                        <input
                                            type="text"
                                            placeholder="Buscar conversas..."
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                                        />
                                        <i className="fas fa-search absolute left-3 top-3 text-gray-400"></i>
                                    </div>
                                    
                                    {/* Filtros inline */}
                                    <div className="flex items-center space-x-3">
                                        <div>
                                            <select
                                                value={crmFilters.status}
                                                onChange={(e) => setCrmFilters({...crmFilters, status: e.target.value})}
                                                className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            >
                                                <option value="">📋 Todos Status</option>
                                                <option value="novo">🆕 Novo Cliente</option>
                                                <option value="andamento">⏳ Em Andamento</option>
                                                <option value="aprovado">✅ Aprovado</option>
                                                <option value="reprovado">❌ Reprovado</option>
                                            </select>
                                        </div>
                                        
                                        <div>
                                            <select
                                                value={crmFilters.priority}
                                                onChange={(e) => setCrmFilters({...crmFilters, priority: e.target.value})}
                                                className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            >
                                                <option value="">⚡ Todas Prioridades</option>
                                                <option value="urgent">🔴 Urgente</option>
                                                <option value="high">🟠 Alta</option>
                                                <option value="medium">🟡 Média</option>
                                                <option value="low">🟢 Baixa</option>
                                            </select>
                                        </div>
                                        
                                        <div className="flex items-center space-x-2">
                                            <input
                                                type="number"
                                                placeholder="Valor mín"
                                                value={crmFilters.minValue}
                                                onChange={(e) => setCrmFilters({...crmFilters, minValue: e.target.value})}
                                                className="w-24 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            />
                                            <span className="text-gray-400">até</span>
                                            <input
                                                type="number"
                                                placeholder="Valor máx"
                                                value={crmFilters.maxValue}
                                                onChange={(e) => setCrmFilters({...crmFilters, maxValue: e.target.value})}
                                                className="w-24 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                            />
                                        </div>
                                        
                                        <div className="flex items-center space-x-2">
                                            <button
                                                onClick={() => setCrmFilters({ status: '', priority: '', minValue: '', maxValue: '' })}
                                                className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
                                                title="Limpar filtros"
                                            >
                                                🗑️ Limpar
                                            </button>
                                            <button
                                                onClick={clearCurrentConversation}
                                                className="px-3 py-2 text-sm text-red-600 hover:text-red-800 hover:bg-red-50 rounded-lg transition-colors"
                                                title="Limpar conversa atual"
                                                disabled={!selectedContact}
                                            >
                                                💬 Limpar Chat
                                            </button>
                                            <button
                                                onClick={clearAllConversations}
                                                className="px-3 py-2 text-sm text-red-700 hover:text-red-900 hover:bg-red-100 rounded-lg transition-colors"
                                                title="Limpar todas as conversas"
                                            >
                                                🗑️ Limpar Tudo
                                            </button>
                                            <button
                                                onClick={loadReports}
                                                className="px-3 py-2 text-sm text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors"
                                                title="Ver relatórios"
                                            >
                                                📊 Relatórios
                                            </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div className="flex-1 flex overflow-hidden">
                            {/* Área de Contatos - Agora ocupa toda a largura */}
                            <div className="bg-white flex flex-col shadow-sm w-full">
                                <div className="p-2">
                                    <h3 className="text-sm font-semibold text-gray-700 mb-1 flex items-center">
                                        <span className="mr-2">👥</span>
                                        Contatos ({filteredContacts.length})
                                    </h3>
                                </div>
                                
                                <div className="flex-1 overflow-y-auto p-2">
                                    {/* Loading de contatos */}
                                    {loadingContacts ? (
                                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                                            <div className="animate-spin text-4xl mb-4">⏳</div>
                                            <h3 className="text-lg font-semibold mb-2">Carregando contatos...</h3>
                                            <p className="text-sm text-center">
                                                Aguarde enquanto buscamos seus contatos do WhatsApp
                                            </p>
                                        </div>
                                    ) : (
                                        <>
                                            {/* Contatos organizados por colunas de status */}
                                            <div className="grid grid-cols-4 gap-2 h-full">
                                        {Object.entries(statusConfig).map(([status, config]) => (
                                            <div key={status} className={'status-column ' + config.color + ' rounded-lg border-2 flex flex-col'}>
                                                {/* Header da coluna */}
                                                <div className="p-1 border-b border-gray-200">
                                                    <h4 className="text-sm font-bold text-gray-800 text-center">
                                                        {config.title}
                                                    </h4>
                                                    <p className="text-xs text-gray-600 text-center mt-0.5">
                                                        {config.count} contato{config.count !== 1 ? 's' : ''}
                                                    </p>
                                                </div>
                                                
                                                {/* Lista de contatos da coluna */}
                                                <div className="flex-1 p-1 space-y-1 overflow-y-auto">
                                                    {contactsByStatus[status].map(contact => (
                                                        <div
                                                            key={contact._id}
                                                            onClick={() => selectContact(contact)}
                                                            className={'contact-card bg-white rounded-lg p-2 border cursor-pointer transition-all duration-200 hover:shadow-md ' + (
                                                                selectedContact?.phoneNumber === contact.phoneNumber 
                                                                ? 'border-green-500 bg-green-50 shadow-md' 
                                                                : 'border-gray-200 hover:border-green-300'
                                                            )}
                                                        >
                                                            <div className="flex items-center space-x-2">
                                                                {/* Avatar menor */}
                                                                <div className="relative flex-shrink-0">
                                                                                                                        <div className="w-8 h-8 bg-gradient-to-br from-green-400 to-green-600 rounded-full flex items-center justify-center text-white font-bold text-xs">
                                                        {contact.name.charAt(0).toUpperCase()}
                                                    </div>
                                                                    {contact.unreadCount > 0 && (
                                                                        <div className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-bold animate-pulse">
                                                                            {contact.unreadCount > 9 ? '9+' : contact.unreadCount}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                
                                                                {/* Informações do contato */}
                                                                <div className="flex-1 min-w-0">
                                                                    <h3 className="text-sm font-bold text-gray-900 truncate">
                                                                        {contact.name}
                                                                    </h3>
                                                                    
                                                                    {/* Última mensagem */}
                                                                    <p className="text-xs text-gray-600 truncate">
                                                                        {contact.lastMessage || 'Nenhuma mensagem'}
                                                                    </p>
                                                                    
                                                                    {/* Informações extras em linha */}
                                                                    <div className="flex items-center justify-between mt-0.5">
                                                                        <span className="text-xs text-gray-400 truncate">
                                                                            📱 {contact.phoneNumber.slice(-4)}
                                                                        </span>
                                                                        {contact.lastMessageTime && (
                                                                            <span className="text-xs text-gray-500">
                                                                                {formatTime(contact.lastMessageTime)}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    
                                                                    {/* Empresa e valor em linha compacta */}
                                                                    <div className="flex items-center justify-between mt-0.5">
                                                                        {contact.crmData && contact.crmData.company && (
                                                                            <span className="text-xs text-blue-600 truncate">
                                                                                🏢 {contact.crmData.company}
                                                                            </span>
                                                                        )}
                                                                                                                                {contact.crmData && contact.crmData.dealValue && contact.crmData.dealValue > 0 && (
                                                            <span className="text-xs text-green-600 font-semibold">
                                                                💰 {formatCurrency(contact.crmData.dealValue)}
                                                            </span>
                                                        )}
                                                                    </div>
                                                                    
                                                                    {/* Prioridade apenas se urgente ou alta */}
                                                                    {contact.crmData && (contact.crmData.priority === 'urgent' || contact.crmData.priority === 'high') && (
                                                                        <div className="mt-0.5">
                                                                            <span className={'px-2 py-0.5 rounded-full text-xs font-medium ' + getPriorityColor(contact.crmData.priority)}>
                                                                                {contact.crmData.priority === 'urgent' ? '🔴 Urgente' : '🟠 Alta'}
                                                                            </span>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                    
                                                    {/* Mensagem quando coluna vazia */}
                                                    {contactsByStatus[status].length === 0 && (
                                                        <div className="text-center py-4 text-gray-400">
                                                            <div className="text-2xl mb-2">📭</div>
                                                            <p className="text-xs">Nenhum contato</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                    
                                    {/* Mensagem quando não há contatos */}
                                    {filteredContacts.length === 0 && (
                                        <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                                            <div className="text-6xl mb-4">🔍</div>
                                            <h3 className="text-lg font-semibold mb-2">Nenhum contato encontrado</h3>
                                            <p className="text-sm text-center">
                                                Tente ajustar os filtros ou buscar por outro termo
                                            </p>
                                        </div>
                                    )}
                                    

                                        </>
                                    )}
                                </div>
                            </div>
                            
                            {/* Área de Status do WhatsApp - Canto superior direito */}
                            {!isConnected && qrCode && (
                                <div className="fixed top-4 right-4 z-40">
                                    <div className="bg-white p-4 rounded-lg shadow-lg border-2 border-yellow-300">
                                        <div className="flex items-center space-x-2 text-yellow-600">
                                            <i className="fab fa-whatsapp text-xl"></i>
                                            <span className="text-sm font-medium">WhatsApp desconectado</span>
                                        </div>
                                        <p className="text-xs text-gray-600 mt-1">
                                            Clique para reconectar
                                        </p>
                                    </div>
                                </div>
                            )}
                        
                        {/* Indicador de Múltiplos Chats */}
                        {openChats.length > 0 && (
                            <div className="multiple-chats-indicator">
                                💬 {openChats.length} conversa{openChats.length > 1 ? 's' : ''} aberta{openChats.length > 1 ? 's' : ''}
                            </div>
                        )}
                        
                        {/* Múltiplos Popups de Chat Arrastáveis */}
                        {openChats.map((chat) => (
                            <div
                                key={chat.id}
                                data-chat-id={chat.id}
                                className="fixed"
                                style={{
                                    left: chat.position.x + 'px',
                                    top: chat.position.y + 'px',
                                    zIndex: chat.zIndex,
                                    width: chat.showCRM ? '800px' : '500px',
                                    height: '600px',
                                    maxWidth: '90vw',
                                    cursor: chat.isDragging ? 'grabbing' : 'auto',
                                    transition: 'width 0.4s ease-out, box-shadow 0.3s ease'
                                }}
                                onClick={() => bringChatToFront(chat.id)}
                            >
                                <div className="bg-white rounded-lg h-full flex flex-col shadow-2xl border border-gray-200 chat-popup">
                                    {/* Header Arrastável */}
                                    <div 
                                        className="bg-gradient-to-r from-green-500 to-green-600 text-white p-3 rounded-t-lg flex items-center justify-between cursor-grab active:cursor-grabbing"
                                        onMouseDown={(e) => startDrag(chat.id, e)}
                                    >
                                        <div className="flex items-center space-x-3">
                                            <div className="w-8 h-8 bg-white bg-opacity-20 rounded-full flex items-center justify-center">
                                                <span className="font-bold text-white text-sm">
                                                    {chat.contact.name.charAt(0).toUpperCase()}
                                                </span>
                                            </div>
                                            <div>
                                                <h3 className="font-bold text-sm">{chat.contact.name}</h3>
                                                <p className="text-green-100 text-xs">📱 {chat.contact.phoneNumber}</p>
                                            </div>
                                        </div>
                                        
                                        <div className="flex items-center space-x-2">
                                            <div className="text-right mr-2">
                                                <div className="text-xs text-green-100">
                                                    {isConnected ? (
                                                        <span className="flex items-center">
                                                            <div className="w-2 h-2 bg-green-300 rounded-full mr-1 animate-pulse"></div>
                                                            Online
                                                        </span>
                                                    ) : (
                                                        <span className="flex items-center">
                                                            <div className="w-2 h-2 bg-red-300 rounded-full mr-1"></div>
                                                            Offline
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    updateChatData(chat.id, { showCRM: !chat.showCRM });
                                                }}
                                                className="p-1 hover:bg-white hover:bg-opacity-20 rounded transition-colors text-xs"
                                                title="CRM"
                                            >
                                                👤
                                            </button>
                                            
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    closeChatPopup(chat.id);
                                                }}
                                                className="p-1 hover:bg-white hover:bg-opacity-20 rounded transition-colors"
                                                title="Fechar conversa"
                                            >
                                                <i className="fas fa-times"></i>
                                            </button>
                                        </div>
                                    </div>
                                    
                                    {/* Área de Mensagens */}
                                    <div className="flex-1 flex overflow-hidden">
                                        {/* Mensagens */}
                                        <div className="flex-1 flex flex-col">
                                            <div 
                                                className="flex-1 overflow-y-auto p-3 bg-gray-50 messages-container"
                                                ref={el => messagesContainerRefs.current[chat.id] = el}
                                            >
                                                <div className="space-y-3">
                                                    {chat.loading ? (
                                                        <div className="text-center text-gray-500 py-8">
                                                            <div className="animate-spin text-2xl mb-2">⏳</div>
                                                            <p className="text-sm">Carregando mensagens...</p>
                                                        </div>
                                                    ) : chat.messages.length === 0 ? (
                                                        <div className="text-center text-gray-500 py-8">
                                                            <div className="text-3xl mb-2">💬</div>
                                                            <p className="text-sm">Nenhuma mensagem ainda</p>
                                                            <p className="text-xs">Inicie a conversa!</p>
                                                        </div>
                                                    ) : (
                                                        chat.messages.map((message, index) => (
                                                            <div
                                                                key={message.messageId || message._id || \`msg-\${index}\`}
                                                                className={\`message-bubble flex \${message.isFromMe ? 'justify-end' : 'justify-start'}\`}
                                                            >
                                                                <div className={\`max-w-xs px-3 py-2 rounded-lg text-sm \${
                                                                    message.isFromMe 
                                                                    ? 'bg-green-500 text-white ml-4' 
                                                                    : 'bg-white text-gray-800 mr-4 shadow-sm border'
                                                                }\`}>
                                                                    {message.type === 'image' && message.mediaUrl && (
                                                                        <div className="mb-2">
                                                                            <img 
                                                                                src={message.mediaUrl} 
                                                                                alt="Imagem" 
                                                                                className="rounded max-w-full h-auto cursor-pointer hover:opacity-90" 
                                                                                onClick={() => window.open(message.mediaUrl, '_blank')}
                                                                                style={{maxHeight: '150px'}}
                                                                            />
                                                                        </div>
                                                                    )}
                                                                    {(message.type === 'audio' || message.type === 'ptt') && message.mediaUrl && (
                                                                        <div className="mb-2">
                                                                            <div className={
                                                                                'flex items-center space-x-2 text-xs mb-2 ' + (message.isFromMe ? 'text-green-100' : 'text-gray-700')
                                                                            }>
                                                                                <i className={
                                                                                    'fas fa-volume-up ' + (message.isFromMe ? 'text-green-200' : 'text-blue-500')
                                                                                }></i>
                                                                                <span className="font-medium">
                                                                                    {message.isFromMe ? 'Você enviou um áudio' : 'Mensagem de Voz'}
                                                                                </span>
                                                                                <span className={message.isFromMe ? 'text-green-300' : 'text-gray-400'}>•</span>
                                                                                <span className={message.isFromMe ? 'text-green-200' : 'text-gray-500'}>Clique para ouvir</span>
                                                                            </div>
                                                                            <div className={
                                                                                'rounded-lg p-3 ' + (message.isFromMe ? 'bg-green-600 bg-opacity-30' : 'bg-gray-50 border')
                                                                            }>
                                                                                <audio 
                                                                                    controls 
                                                                                    className="w-full h-12" 
                                                                                    style={{
                                                                                        width: '100%', 
                                                                                        minWidth: '300px',
                                                                                        filter: message.isFromMe ? 'brightness(1.2)' : 'none'
                                                                                    }}
                                                                                    preload="metadata"
                                                                                >
                                                                                <source src={message.mediaUrl} type="audio/mpeg" />
                                                                                <source src={message.mediaUrl} type="audio/wav" />
                                                                                <source src={message.mediaUrl} type="audio/ogg" />
                                                                                    <source src={message.mediaUrl} type="audio/webm" />
                                                                                Seu navegador não suporta áudio.
                                                                            </audio>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                    {message.type === 'document' && message.mediaUrl && (
                                                                        <div className="mb-2">
                                                                            <div className="flex items-center space-x-2 text-xs p-2 bg-gray-100 rounded border">
                                                                                <i className="fas fa-file-alt text-blue-500"></i>
                                                                                <div className="flex-1">
                                                                                    <div className="font-medium truncate">Documento</div>
                                                                                    <div className="text-xs text-gray-500">Clique para abrir</div>
                                                                                </div>
                                                                                <button
                                                                                    onClick={() => window.open(message.mediaUrl, '_blank')}
                                                                                    className="text-blue-500 hover:text-blue-700"
                                                                                >
                                                                                    <i className="fas fa-download"></i>
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                    {message.body && (
                                                                        <p className="whitespace-pre-wrap break-words">{message.body}</p>
                                                                    )}
                                                                    <p className={\`text-xs mt-1 \${message.isFromMe ? 'text-green-100' : 'text-gray-500'}\`}>
                                                                        {formatTime(message.timestamp)}
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        ))
                                                    )}
                                                </div>
                                            </div>
                                            
                                            {/* Campo de Envio */}
                                            <div className="p-3 bg-white border-t">
                                                <form onSubmit={(e) => sendMessage(chat.id, e)} data-chat-id={chat.id} className="flex items-center space-x-2">
                                                    <div className="flex-1 relative">
                                                        <input
                                                            type="text"
                                                            value={chat.newMessage}
                                                            onChange={(e) => updateChatData(chat.id, { newMessage: e.target.value })}
                                                            placeholder="Digite sua mensagem..."
                                                            className="w-full p-2 pr-16 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                                                        />
                                                        
                                                                                                <div className="absolute right-2 top-2 flex items-center space-x-1">
                                            {/* Botão de Anexar Arquivo */}
                                            <input
                                                type="file"
                                                id={\`file-input-\${chat.id}\`}
                                                className="hidden"
                                                onChange={(e) => handleFileSelect(chat.id, e)}
                                                accept="*/*"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => document.getElementById(\`file-input-\${chat.id}\`).click()}
                                                className="text-gray-400 hover:text-green-500 p-1 text-sm transition-colors"
                                                title="Anexar arquivo"
                                                disabled={chat.loading || chat.uploading}
                                            >
                                                {chat.uploading ? '⏳' : '📎'}
                                            </button>
                                            
                                            {/* Botão de Gravar Áudio */}
                                            <button
                                                type="button"
                                                onClick={() => toggleAudioRecording(chat.id)}
                                                className={
                                                    'p-1 text-sm transition-colors ' + (chat.isRecording 
                                                        ? 'text-red-500 hover:text-red-600 animate-pulse' 
                                                        : 'text-gray-400 hover:text-green-500')
                                                }
                                                title={chat.isRecording ? "Parar gravação" : "Gravar áudio"}
                                                disabled={chat.loading || chat.uploading}
                                            >
                                                {chat.isRecording ? '🔴' : '🎙️'}
                                            </button>
                                            
                                            {/* Botão de Emojis */}
                                            <button
                                                type="button"
                                                onClick={() => toggleEmojiPicker(chat.id)}
                                                className="text-gray-400 hover:text-green-500 p-1 text-sm transition-colors"
                                                title="Emojis"
                                            >
                                                😊
                                            </button>
                                        </div>
                                        
                                        {/* Painel de Emoji */}
                                        {chat.showEmojiPicker && (
                                            <div className="absolute right-0 bottom-full mb-2 bg-white border border-gray-200 rounded-lg shadow-lg p-3 z-50">
                                                <div className="grid grid-cols-8 gap-1 max-w-xs">
                                                    {frequentEmojis.map((emoji, index) => (
                                                        <button
                                                            key={index}
                                                            type="button"
                                                            onClick={() => addEmojiToMessage(chat.id, emoji)}
                                                            className="hover:bg-gray-100 p-1 rounded text-lg"
                                                            title={emoji}
                                                        >
                                                            {emoji}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        
                                        {/* Painel de Controle de Gravação */}
                                        {chat.isRecording && (
                                            <div className="absolute right-0 bottom-full mb-2 bg-red-50 border border-red-200 rounded-lg shadow-lg p-3 z-50 min-w-[200px]">
                                                <div className="flex items-center justify-between mb-2">
                                                    <div className="flex items-center space-x-2">
                                                        <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                                                        <span className="text-sm font-medium text-red-700">Gravando...</span>
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => stopAudioRecording(chat.id)}
                                                    className="w-full bg-red-500 hover:bg-red-600 text-white px-3 py-2 rounded text-sm font-medium"
                                                >
                                                    ⏹️ Parar Gravação
                                                </button>
                                            </div>
                                        )}
                                        
                                        {/* Preview do Arquivo Selecionado */}
                                        {chat.selectedFile && (
                                            <div className={
                                                'absolute left-0 bottom-full mb-2 rounded-lg p-2 flex items-center space-x-2 max-w-xs ' + (chat.selectedFile.type?.startsWith('audio/') 
                                                    ? 'bg-green-50 border border-green-200 animate-pulse' 
                                                    : 'bg-blue-50 border border-blue-200')
                                            }>
                                                <div className={chat.selectedFile.type?.startsWith('audio/') ? 'text-green-500' : 'text-blue-500'}>
                                                    {chat.selectedFile.type?.startsWith('image/') ? '🖼️' : 
                                                     chat.selectedFile.type?.startsWith('video/') ? '🎥' : 
                                                     chat.selectedFile.type?.startsWith('audio/') ? '🎤' : '📄'}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className={
                                                        'text-sm font-medium truncate ' + (chat.selectedFile.type?.startsWith('audio/') ? 'text-green-800' : 'text-gray-800')
                                                    }>
                                                        {chat.selectedFile.name}
                                                    </p>
                                                    <p className={
                                                        'text-xs ' + (chat.selectedFile.type?.startsWith('audio/') ? 'text-green-600' : 'text-gray-500')
                                                    }>
                                                        {formatFileSize(chat.selectedFile.size)}
                                                        {chat.selectedFile.type?.startsWith('audio/') && 
                                                            <span className="ml-1 font-medium">• Pronto para envio!</span>
                                                        }
                                                    </p>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => removeSelectedFile(chat.id)}
                                                    className="text-gray-400 hover:text-red-500 p-1"
                                                    title="Remover arquivo"
                                                >
                                                    ❌
                                                </button>
                                            </div>
                                        )}
                                                    </div>
                                                    
                                                    <button
                                                        type="submit"
                                                        disabled={chat.loading || chat.uploading || (!chat.newMessage.trim() && !chat.selectedFile)}
                                                        className="bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white p-3 rounded-lg transition-colors flex items-center justify-center min-w-[48px]"
                                                    >
                                                                                                                    {chat.loading ? (
                                                            <i className="fas fa-spinner animate-spin"></i>
                                                        ) : (
                                                            <i className="fas fa-paper-plane"></i>
                                                        )}
                                                    </button>
                                                </form>
                                            </div>
                                        </div>
                                        
                                        {/* Painel CRM Expansível - agora ao lado das mensagens */}
                                        {chat.showCRM && (
                                            <div 
                                                className="w-80 bg-white border-l-2 border-blue-200 flex flex-col shadow-lg"
                                                style={{
                                                    animation: 'slideInFromRight 0.4s ease-out',
                                                    maxHeight: '100%'
                                                }}
                                            >
                                                {/* Header CRM */}
                                                <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-blue-100">
                                                    <div className="flex items-center justify-between">
                                                        <h4 className="font-semibold text-gray-800 flex items-center">
                                                            <i className="fas fa-user-circle mr-2 text-blue-500 text-lg"></i>
                                                            Perfil do Cliente
                                                        </h4>
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                updateChatData(chat.id, { showCRM: false });
                                                            }}
                                                            className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-white hover:bg-opacity-50"
                                                            title="Fechar CRM"
                                                        >
                                                            <i className="fas fa-times"></i>
                                                        </button>
                                                    </div>
                                                </div>
                                                
                                                {/* Conteúdo CRM Funcional */}
                                                <div className="flex-1 overflow-y-auto">
                                                    {/* Perfil do Cliente */}
                                                    <div className="p-4 border-b border-gray-100 bg-white">
                                                        <div className="text-center mb-4">
                                                            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3">
                                                                <i className="fas fa-user text-blue-500 text-xl"></i>
                                                            </div>
                                                            <h3 className="font-bold text-gray-800 text-lg">
                                                                {chat.clientData?.client?.name || chat.contact.name}
                                                            </h3>
                                                            <p className="text-sm text-gray-500">{chat.contact.phoneNumber}</p>
                                                        </div>
                                                    </div>
                                                    
                                                    {/* Formulário CRM Funcional */}
                                                    <div className="p-4 space-y-4">
                                                        {/* Nome e Email */}
                                                        <div className="space-y-3">
                                                            <div>
                                                                <label className="text-xs text-gray-600 font-medium">Nome Completo</label>
                                                                <input
                                                                    type="text"
                                                                    value={chat.crmForm?.name || chat.clientData?.client?.name || chat.contact.name || ''}
                                                                    onChange={(e) => updateChatData(chat.id, { 
                                                                        crmForm: { ...chat.crmForm, name: e.target.value }
                                                                    })}
                                                                    className="w-full mt-1 p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                                    placeholder="Nome do cliente"
                                                                />
                                                            </div>
                                                            
                                                            <div>
                                                                <label className="text-xs text-gray-600 font-medium">E-mail</label>
                                                                <input
                                                                    type="email"
                                                                    value={chat.crmForm?.email || chat.clientData?.client?.email || ''}
                                                                    onChange={(e) => updateChatData(chat.id, { 
                                                                        crmForm: { ...chat.crmForm, email: e.target.value }
                                                                    })}
                                                                    className="w-full mt-1 p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                                    placeholder="email@exemplo.com"
                                                                />
                                                            </div>
                                                            
                                                            <div>
                                                                <label className="text-xs text-gray-600 font-medium">Empresa</label>
                                                                <input
                                                                    type="text"
                                                                    value={chat.crmForm?.company || chat.clientData?.client?.company || ''}
                                                                    onChange={(e) => updateChatData(chat.id, { 
                                                                        crmForm: { ...chat.crmForm, company: e.target.value }
                                                                    })}
                                                                    className="w-full mt-1 p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                                    placeholder="Nome da empresa"
                                                                />
                                                            </div>
                                                        </div>
                                                        
                                                        {/* Status e Prioridade */}
                                                        <div className="grid grid-cols-2 gap-3">
                                                            <div>
                                                                <label className="text-xs text-gray-600 font-medium">Status</label>
                                                                <select
                                                                    value={chat.crmForm?.status || chat.clientData?.client?.status || 'novo'}
                                                                    onChange={(e) => updateChatData(chat.id, { 
                                                                        crmForm: { ...chat.crmForm, status: e.target.value }
                                                                    })}
                                                                    className="w-full mt-1 p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                                >
                                                                    <option value="novo">🆕 Novo</option>
                                                                    <option value="andamento">⏳ Em Andamento</option>
                                                                    <option value="aprovado">✅ Aprovado</option>
                                                                    <option value="reprovado">❌ Reprovado</option>
                                                                </select>
                                                            </div>
                                                            
                                                            <div>
                                                                <label className="text-xs text-gray-600 font-medium">Prioridade</label>
                                                                <select
                                                                    value={(() => {
                                                                        const dbPriority = chat.crmForm?.priority || chat.clientData?.client?.priority || 'normal';
                                                                        const reverseMap = { 'low': 'baixa', 'medium': 'normal', 'high': 'alta', 'urgent': 'urgente' };
                                                                        return reverseMap[dbPriority] || dbPriority;
                                                                    })()}
                                                                    onChange={(e) => updateChatData(chat.id, { 
                                                                        crmForm: { ...chat.crmForm, priority: e.target.value }
                                                                    })}
                                                                    className="w-full mt-1 p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                                >
                                                                    <option value="baixa">🟢 Baixa</option>
                                                                    <option value="normal">🟡 Normal</option>
                                                                    <option value="alta">🟠 Alta</option>
                                                                    <option value="urgente">🔴 Urgente</option>
                                                                </select>
                                                            </div>
                                                        </div>
                                                        
                                                        {/* Valor do Negócio */}
                                                        <div>
                                                            <label className="text-xs text-gray-600 font-medium">Valor Potencial (R$)</label>
                                                            <input
                                                                type="number"
                                                                value={chat.crmForm?.value || chat.clientData?.client?.dealValue || ''}
                                                                onChange={(e) => updateChatData(chat.id, { 
                                                                    crmForm: { ...chat.crmForm, value: e.target.value }
                                                                })}
                                                                className="w-full mt-1 p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                                placeholder="0,00"
                                                                min="0"
                                                                step="0.01"
                                                            />
                                                        </div>
                                                        
                                                        {/* Nova Nota */}
                                                        <div>
                                                            <label className="text-xs text-gray-600 font-medium">Adicionar Nota</label>
                                                            <textarea
                                                                value={chat.newNote || ''}
                                                                onChange={(e) => updateChatData(chat.id, { newNote: e.target.value })}
                                                                className="w-full mt-1 p-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                                                placeholder="Digite uma observação sobre este cliente..."
                                                                rows={3}
                                                            />
                                                        </div>
                                                        
                                                        {/* Botões de Ação */}
                                                        <div className="flex space-x-2">
                                                            <button
                                                                onClick={() => saveCRMData(chat.id)}
                                                                disabled={chat.savingCRM}
                                                                className="flex-1 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white py-2 px-3 rounded-lg text-sm font-medium transition-colors flex items-center justify-center"
                                                            >
                                                                {chat.savingCRM ? (
                                                                    <>
                                                                        <i className="fas fa-spinner animate-spin mr-2"></i>
                                                                        Salvando...
                                                                    </>
                                                                ) : (
                                                                    <>
                                                                        <i className="fas fa-save mr-2"></i>
                                                                        Salvar
                                                                    </>
                                                                )}
                                                            </button>
                                                            
                                                            {chat.newNote && (
                                                                <button
                                                                    onClick={() => addChatNote(chat.id)}
                                                                    disabled={chat.addingNote}
                                                                    className="bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white py-2 px-3 rounded-lg text-sm font-medium transition-colors"
                                                                >
                                                                    {chat.addingNote ? (
                                                                        <i className="fas fa-spinner animate-spin"></i>
                                                                    ) : (
                                                                        <i className="fas fa-plus"></i>
                                                                    )}
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                    
                                                    {/* Histórico de Notas */}
                                                    {chat.clientData?.client?.notes && chat.clientData.client.notes.length > 0 && (
                                                        <div className="border-t border-gray-200">
                                                            <div className="p-4">
                                                                <h5 className="font-semibold text-gray-700 mb-3 flex items-center">
                                                                    <i className="fas fa-history mr-2 text-orange-500"></i>
                                                                    Histórico
                                                                    <span className="ml-2 bg-orange-100 text-orange-600 px-2 py-1 rounded-full text-xs">
                                                                        {chat.clientData.client.notes.length}
                                                                    </span>
                                                                </h5>
                                                                <div className="space-y-2 max-h-48 overflow-y-auto">
                                                                    {chat.clientData.client.notes.slice(-5).reverse().map((note, noteIndex) => {
                                                                        const originalIndex = chat.clientData.client.notes.length - 1 - noteIndex;
                                                                        return (
                                                                            <div key={noteIndex} className="bg-gray-50 border-l-3 border-orange-300 p-3 rounded-r-lg group hover:bg-orange-50 transition-colors">
                                                                                <div className="flex justify-between items-start mb-1">
                                                                                    <p className="text-sm text-gray-700 flex-1 pr-2">{note.text}</p>
                                                                                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex space-x-1">
                                                                                        <button
                                                                                            onClick={() => editChatNote(chat.id, originalIndex)}
                                                                                            className="text-blue-500 hover:text-blue-700 text-xs p-1"
                                                                                            title="Editar nota"
                                                                                            disabled={chat.editingNote}
                                                                                        >
                                                                                            <i className="fas fa-edit"></i>
                                                                                        </button>
                                                                                        <button
                                                                                            onClick={() => deleteChatNote(chat.id, originalIndex)}
                                                                                            className="text-red-500 hover:text-red-700 text-xs p-1"
                                                                                            title="Excluir nota"
                                                                                            disabled={chat.deletingNote}
                                                                                        >
                                                                                            <i className="fas fa-trash"></i>
                                                                                        </button>
                                                                                    </div>
                                                                                </div>
                                                                                <div className="flex items-center text-xs text-gray-500">
                                                                                    <i className="fas fa-clock mr-1"></i>
                                                                                    <span>{formatTime(note.createdAt)}</span>
                                                                                    {note.updatedAt && note.updatedAt !== note.createdAt && (
                                                                                        <span className="ml-2 text-blue-500">
                                                                                            <i className="fas fa-edit mr-1"></i>
                                                                                            editado
                                                                                        </span>
                                                                                    )}
                                                                                </div>
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                            
                            {/* Modal de Relatórios */}
                            {showReports && reportData && (
                                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                                    <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                                        {/* Header */}
                                        <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white p-6 rounded-t-lg">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <h2 className="text-2xl font-bold">📊 Relatórios CRM</h2>
                                                    <p className="text-blue-200">Análise completa de vendas e clientes</p>
                                                </div>
                                                <button
                                                    onClick={() => setShowReports(false)}
                                                    className="p-2 hover:bg-blue-600 rounded-full transition-colors"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        </div>
                                        
                                        <div className="p-6 space-y-6">
                                            {/* Resumo Geral */}
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                                <div className="bg-blue-50 p-4 rounded-lg text-center">
                                                    <div className="text-2xl font-bold text-blue-600">{reportData.total}</div>
                                                    <div className="text-sm text-blue-500">👥 Total de Clientes</div>
                                                </div>
                                                <div className="bg-green-50 p-4 rounded-lg text-center">
                                                    <div className="text-2xl font-bold text-green-600">
                                                        R$ {reportData.totalPipeline.toLocaleString('pt-BR')}
                                                    </div>
                                                    <div className="text-sm text-green-500">💰 Pipeline Total</div>
                                                </div>
                                                <div className="bg-yellow-50 p-4 rounded-lg text-center">
                                                    <div className="text-2xl font-bold text-yellow-600">
                                                        R$ {Math.round(reportData.avgDealValue).toLocaleString('pt-BR')}
                                                    </div>
                                                    <div className="text-sm text-yellow-500">📈 Ticket Médio</div>
                                                </div>
                                                <div className="bg-purple-50 p-4 rounded-lg text-center">
                                                    <div className="text-2xl font-bold text-purple-600">
                                                        {reportData.byStatus.client || 0}
                                                    </div>
                                                    <div className="text-sm text-purple-500">✅ Clientes Ativos</div>
                                                </div>
                                            </div>
                                            
                                            {/* Status dos Clientes */}
                                            <div className="bg-gray-50 p-4 rounded-lg">
                                                <h3 className="text-lg font-semibold mb-4">📊 Distribuição por Status</h3>
                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                                    <div className="text-center">
                                                        <div className="text-xl font-bold text-yellow-600">{reportData.byStatus.novo || 0}</div>
                                                        <div className="text-xs text-yellow-500">🆕 Novos</div>
                                                    </div>
                                                    <div className="text-center">
                                                        <div className="text-xl font-bold text-blue-600">{reportData.byStatus.andamento || 0}</div>
                                                        <div className="text-xs text-blue-500">⏳ Em Andamento</div>
                                                    </div>
                                                    <div className="text-center">
                                                        <div className="text-xl font-bold text-green-600">{reportData.byStatus.aprovado || 0}</div>
                                                        <div className="text-xs text-green-500">✅ Aprovados</div>
                                                    </div>
                                                    <div className="text-center">
                                                        <div className="text-xl font-bold text-red-600">{reportData.byStatus.reprovado || 0}</div>
                                                        <div className="text-xs text-red-500">❌ Reprovados</div>
                                                    </div>
                                                </div>
                                            </div>
                                            
                                            {/* Top Clientes */}
                                            {reportData.topClients.length > 0 && (
                                                <div className="bg-gray-50 p-4 rounded-lg">
                                                    <h3 className="text-lg font-semibold mb-4">🏆 Top Clientes por Valor</h3>
                                                    <div className="space-y-2">
                                                        {reportData.topClients.slice(0, 5).map((client, index) => (
                                                            <div key={index} className="flex items-center justify-between bg-white p-3 rounded border">
                                                                <div className="flex items-center space-x-3">
                                                                    <div className="w-8 h-8 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center text-white font-bold text-sm">
                                                                        {index + 1}
                                                                    </div>
                                                                    <div>
                                                                        <div className="font-medium">{client.name}</div>
                                                                        <div className="text-sm text-gray-500">
                                                                            {client.company && client.company + ' • '}📞 {client.phoneNumber}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div className="text-right">
                                                                    <div className="text-green-600 font-bold">
                                                                        R$ {client.dealValue.toLocaleString('pt-BR')}
                                                                    </div>
                                                                    <div className={'text-xs px-2 py-1 rounded-full ' + getStatusColor(client.status)}>
                                                                        {client.status?.toUpperCase()}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            
                                            {/* Notas Recentes */}
                                            {reportData.recentNotes.length > 0 && (
                                                <div className="bg-gray-50 p-4 rounded-lg">
                                                    <h3 className="text-lg font-semibold mb-4">📝 Últimas Anotações</h3>
                                                    <div className="space-y-3 max-h-64 overflow-y-auto">
                                                        {reportData.recentNotes.slice(0, 10).map((note, index) => (
                                                            <div key={index} className="bg-white p-3 rounded border">
                                                                <div className="flex items-start justify-between">
                                                                    <div className="flex-1">
                                                                        <p className="text-sm text-gray-800">{note.text}</p>
                                                                        <div className="text-xs text-gray-500 mt-2">
                                                                            👤 {note.clientName} ({note.clientPhone}) • ✍️ {note.createdBy} • 📅 {formatDate(note.createdAt)}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        
                                        {/* Footer */}
                                        <div className="p-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
                                            <div className="flex items-center justify-between">
                                                <p className="text-sm text-gray-500">
                                                    Relatório gerado em {new Date().toLocaleString('pt-BR')}
                                                </p>
                                                <button
                                                    onClick={() => setShowReports(false)}
                                                    className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
                                                >
                                                    Fechar
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                );
            }
            
            const root = ReactDOM.createRoot(document.getElementById('app'));
            root.render(<App />);
        </script>
    </body>
    </html>
  `;
}

// Criar diretórios necessários
if (!fs.existsSync('public')) {
  fs.mkdirSync('public');
}
if (!fs.existsSync('public/uploads')) {
  fs.mkdirSync('public/uploads');
}

// Inicializar WhatsApp
setTimeout(() => {
  console.log('🔄 Inicializando cliente WhatsApp...');
  initializeWhatsAppClient();
}, 2000);

// Servidor
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log('🚀 Clerky CRM rodando na porta', PORT);
  console.log('🌐 Acesse: http://localhost:' + PORT);
  console.log('📱 Aguardando conexão com WhatsApp...');
  console.log('⚡ Modo: Tempo real (sem salvar contatos no banco)');
});

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Erro não capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada:', reason);
}); 