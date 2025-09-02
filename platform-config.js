const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Configuração cross-platform para Puppeteer e WhatsApp Web.js
 * Detecta automaticamente o sistema operacional e aplica as configurações necessárias
 */

class PlatformConfig {
  constructor() {
    this.platform = os.platform();
    this.isWindows = this.platform === 'win32';
    this.isMac = this.platform === 'darwin';
    this.isLinux = this.platform === 'linux';
    
    console.log(`🖥️ Sistema operacional detectado: ${this.platform}`);
    console.log(`📱 Configuração: ${this.isWindows ? 'Windows' : this.isMac ? 'macOS' : 'Linux'}`);
  }

  /**
   * Retorna as configurações do Puppeteer específicas para a plataforma atual
   */
  getPuppeteerConfig() {
    // Criar diretório e argumentos únicos para cada instância
    const clientId = process.env.WHATSAPP_CLIENT_ID || 'clerky-crm';
    const userDataDir = path.join('/tmp', `chrome-data-${clientId}`);
    
    // Criar o diretório se não existir
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      console.log(`📁 Diretório criado: ${userDataDir}`);
    }
    
    const baseConfig = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        `--user-data-dir=${userDataDir}`,
        '--disable-extensions-file-access-check',
        '--disable-extensions-http-throttling',
        '--disable-extensions',
        '--disable-plugins',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-background-networking',
        '--disable-sync-preferences',
        '--disable-component-update',
        '--disable-accelerated-2d-canvas',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-pings',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=VizDisplayCompositor',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-hang-monitor',
        '--disable-client-side-phishing-detection',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-background-networking',
        '--disable-sync-preferences',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-web-security',
        '--disable-features=site-per-process',
        '--allow-running-insecure-content',
        '--disable-webgl',
        '--disable-threaded-animation',
        '--disable-threaded-scrolling',
        '--disable-in-process-stack-traces',
        '--disable-histogram-customizer',
        '--disable-gl-extensions',
        '--disable-composited-antialiasing',
        '--disable-canvas-aa',
        '--disable-3d-apis',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-jpeg-decoding',
        '--disable-accelerated-mjpeg-decode',
        '--disable-app-list-dismiss-on-blur',
        '--disable-accelerated-video-decode'
      ]
    };

    // Configurações específicas para Windows
    if (this.isWindows) {
      baseConfig.args.push(
        '--disable-features=TranslateUI',
        '--disable-features=Translate',
        '--disable-ipc-flooding-protection',
        '--disable-background-networking'
      );
    }

    // Configurações específicas para macOS
    if (this.isMac) {
      baseConfig.args.push(
        '--disable-features=VizDisplayCompositor'
      );
    }

    // Configurações específicas para Linux
    if (this.isLinux) {
      baseConfig.args.push(
        '--disable-features=VizDisplayCompositor',
        '--run-all-compositor-stages-before-draw',
        '--disable-dev-shm-usage'
      );
    }

    // Tentar encontrar o executável do Chrome/Chromium automaticamente
    const executablePath = this.findChromiumExecutable();
    if (executablePath) {
      baseConfig.executablePath = executablePath;
      console.log(`🌐 Executável do Chrome encontrado: ${executablePath}`);
    } else {
      console.log('🔍 Usando Chromium padrão do Puppeteer');
    }

    return baseConfig;
  }

  /**
   * Tenta encontrar o executável do Chrome/Chromium instalado no sistema
   */
  findChromiumExecutable() {
    const possiblePaths = [];

    if (this.isWindows) {
      possiblePaths.push(
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Users\\' + os.userInfo().username + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe'
      );
    } else if (this.isMac) {
      possiblePaths.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'
      );
    } else if (this.isLinux) {
      possiblePaths.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium'
      );
    }

    // Verificar se algum dos caminhos existe
    for (const chromePath of possiblePaths) {
      if (chromePath && fs.existsSync(chromePath)) {
        return chromePath;
      }
    }

    return null;
  }

  /**
   * Retorna as configurações específicas do WhatsApp Web.js para a plataforma
   */
  getWhatsAppConfig() {
    return {
      authStrategy: 'LocalAuth',
      clientId: process.env.WHATSAPP_CLIENT_ID || 'clerky-crm',
      puppeteer: this.getPuppeteerConfig(),
      authTimeoutMs: 180000, // Aumentado para 3 minutos
      restartOnAuthFail: true,
      qrMaxRetries: 3,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 90000, // Aumentado para 1.5 minutos
      // webVersionCache removido para evitar problemas de DNS
      // O WhatsApp Web.js usará a versão padrão
    };
  }

  /**
   * Configurações específicas para uploads e arquivos
   */
  getFileConfig() {
    const baseUploadPath = path.join(process.cwd(), 'public', 'uploads');
    
    return {
      uploadPath: baseUploadPath,
      maxFileSize: 50 * 1024 * 1024, // 50MB
      allowedTypes: {
        images: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
        documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'],
        audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac'],
        video: ['.mp4', '.avi', '.mov', '.wmv', '.flv']
      },
      separator: this.isWindows ? '\\' : '/'
    };
  }

  /**
   * Configurações de ambiente e variáveis
   */
  getEnvironmentConfig() {
    return {
      nodeEnv: process.env.NODE_ENV || 'development',
      port: process.env.PORT,
      host: process.env.HOST || 'localhost',
      mongoUri: process.env.MONGODB_URI,
      sessionSecret: process.env.SESSION_SECRET
    };
  }

  /**
   * Informações sobre a plataforma atual
   */
  getPlatformInfo() {
    return {
      platform: this.platform,
      isWindows: this.isWindows,
      isMac: this.isMac,
      isLinux: this.isLinux,
      arch: os.arch(),
      nodeVersion: process.version,
      totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB',
      freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024) + 'GB',
      cpus: os.cpus().length
    };
  }

  /**
   * Exibe informações da plataforma no console
   */
  logPlatformInfo() {
    const info = this.getPlatformInfo();
    console.log('🖥️ ═══════════════════════════════════════');
    console.log('📊 INFORMAÇÕES DA PLATAFORMA');
    console.log('🖥️ ═══════════════════════════════════════');
    console.log(`🔹 Sistema: ${info.platform}`);
    console.log(`🔹 Arquitetura: ${info.arch}`);
    console.log(`🔹 Node.js: ${info.nodeVersion}`);
    console.log(`🔹 CPUs: ${info.cpus}`);
    console.log(`🔹 RAM Total: ${info.totalMemory}`);
    console.log(`🔹 RAM Livre: ${info.freeMemory}`);
    console.log('🖥️ ═══════════════════════════════════════');
  }
}

module.exports = new PlatformConfig(); 