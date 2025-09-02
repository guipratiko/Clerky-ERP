# 🚀 Clerky CRM - Sistema Cross-Platform

Sistema de CRM integrado com WhatsApp Web desenvolvido em Node.js, com suporte nativo para **Windows**, **macOS** e **Linux**.

## 📋 Índice

- [🎯 Características](#-características)
- [⚙️ Pré-requisitos](#️-pré-requisitos)
- [🔧 Instalação Rápida](#-instalação-rápida)
- [🖥️ Instalação por Plataforma](#️-instalação-por-plataforma)
- [🚀 Execução](#-execução)
- [📱 Configuração do WhatsApp](#-configuração-do-whatsapp)
- [🔍 Solução de Problemas](#-solução-de-problemas)
- [🛠️ Scripts Disponíveis](#️-scripts-disponíveis)

## 🎯 Características

- ✅ **Cross-Platform**: Funciona nativamente no Windows, macOS e Linux
- ✅ **WhatsApp Web Integration**: Integração completa com WhatsApp Web
- ✅ **CRM Completo**: Gestão de contatos, mensagens e relacionamentos
- ✅ **Disparo em Massa**: Envio de mensagens para múltiplos contatos
- ✅ **Templates**: Sistema de templates para mensagens
- ✅ **Dashboard em Tempo Real**: Interface web moderna e responsiva
- ✅ **MongoDB**: Banco de dados NoSQL para escalabilidade
- ✅ **Detecção Automática**: Configuração automática baseada no sistema operacional

## ⚙️ Pré-requisitos

### Todos os Sistemas
- **Node.js** versão 16 ou superior ([Download](https://nodejs.org/))
- **npm** (incluído com Node.js)
- **MongoDB** ou MongoDB Atlas (nuvem)
- **Conexão com Internet** estável

### Windows
- Windows 10 ou superior
- PowerShell ou Command Prompt

### macOS
- macOS 10.15 (Catalina) ou superior
- Xcode Command Line Tools (instala automaticamente)

### Linux
- Ubuntu 18.04+, Debian 10+, CentOS 7+, ou distribuições equivalentes
- Build essentials (gcc, make, etc.)

## 🔧 Instalação Rápida

### 1. Clone o Repositório
```bash
git clone https://github.com/seu-usuario/clerky-crm.git
cd clerky-crm
```

### 2. Configuração Automática Cross-Platform
```bash
npm run setup
```

Este comando irá:
- ✅ Detectar automaticamente seu sistema operacional
- ✅ Instalar todas as dependências necessárias
- ✅ Baixar e configurar o Chromium
- ✅ Criar diretórios necessários
- ✅ Configurar arquivos de ambiente
- ✅ Testar a configuração

### 3. Executar o Projeto
```bash
npm run dev
```

### 4. Acessar o Sistema
Abra seu navegador e acesse: [http://localhost:3001](http://localhost:3001)

## 🖥️ Instalação por Plataforma

<details>
<summary>🪟 <strong>Windows</strong></summary>

### PowerShell (Recomendado)
```powershell
# 1. Clone o repositório
git clone https://github.com/seu-usuario/clerky-crm.git
cd clerky-crm

# 2. Instalação automática
npm run setup

# 3. Executar (modo Windows)
npm run dev:windows
```

### Command Prompt
```cmd
REM 1. Clone o repositório
git clone https://github.com/seu-usuario/clerky-crm.git
cd clerky-crm

REM 2. Instalação automática
npm run setup

REM 3. Executar
npm run dev:windows
```

### Problemas Comuns no Windows
- **Erro de permissão**: Execute como Administrador
- **Antivírus**: Adicione a pasta do projeto às exceções
- **Firewall**: Permita conexões na porta 3001

</details>

<details>
<summary>🍎 <strong>macOS</strong></summary>

### Terminal
```bash
# 1. Clone o repositório
git clone https://github.com/seu-usuario/clerky-crm.git
cd clerky-crm

# 2. Instalação automática
npm run setup

# 3. Executar (modo macOS)
npm run dev:mac
```

### Homebrew (Opcional - para instalar Node.js)
```bash
# Instalar Node.js via Homebrew
brew install node

# Verificar instalação
node --version
npm --version
```

### Problemas Comuns no macOS
- **Xcode Command Line Tools**: `xcode-select --install`
- **Permissões**: Use `sudo` apenas se necessário
- **Gatekeeper**: Permita a execução do Chromium nas configurações de segurança

</details>

<details>
<summary>🐧 <strong>Linux</strong></summary>

### Ubuntu/Debian
```bash
# 1. Instalar dependências do sistema
sudo apt update
sudo apt install -y nodejs npm git build-essential

# 2. Clone o repositório
git clone https://github.com/seu-usuario/clerky-crm.git
cd clerky-crm

# 3. Instalação automática
npm run setup

# 4. Executar
npm run dev
```

### CentOS/RHEL/Fedora
```bash
# 1. Instalar dependências do sistema
sudo yum install -y nodejs npm git gcc gcc-c++ make

# 2. Clone o repositório
git clone https://github.com/seu-usuario/clerky-crm.git
cd clerky-crm

# 3. Instalação automática
npm run setup

# 4. Executar
npm run dev
```

### Problemas Comuns no Linux
- **Dependências**: Instale build-essential ou equivalent
- **Permissões**: Não use sudo com npm (use nvm se necessário)
- **Sandbox**: O Chromium roda em modo sandbox automaticamente

</details>

## 🚀 Execução

### Scripts Principais
```bash
# Desenvolvimento (detecta plataforma automaticamente)
npm run dev

# Produção
npm start

# Scripts específicos da plataforma
npm run dev:windows    # Windows
npm run dev:mac        # macOS
npm run dev:linux      # Linux (mesmo que npm run dev)
```

### Portas e Acessos
- **Aplicação Web**: [http://localhost:3001](http://localhost:3001)
- **API**: [http://localhost:3001/api](http://localhost:3001/api)
- **Socket.IO**: Conecta automaticamente na mesma porta

## 📱 Configuração do WhatsApp

### 1. Acesse o Sistema
Abra [http://localhost:3001](http://localhost:3001) em seu navegador

### 2. Login Inicial
- **Usuário**: admin
- **Senha**: admin123

### 3. Conectar WhatsApp Web
1. Clique em "Conectar WhatsApp"
2. Escaneie o QR Code com seu celular
3. Aguarde a conexão ser estabelecida
4. ✅ Sistema pronto para uso!

### 4. Primeira Configuração
- Configure suas integrações no menu "Configurações"
- Adicione usuários no menu "Usuários"
- Crie templates no menu "Templates"

## 🔍 Solução de Problemas

### Erro: "Could not find expected browser (chrome)"
```bash
# Solução 1: Reinstalar dependências
npm run setup

# Solução 2: Forçar download do Chromium
npm run install:chromium

# Solução 3: Limpar cache e reinstalar
rm -rf node_modules package-lock.json
npm run setup
```

### Erro: "MongoDB connection failed"
1. Verifique sua conexão com internet
2. Confirme as credenciais no arquivo `.env`
3. Teste a conexão MongoDB externamente

### Erro: "Port 3001 already in use"
```bash
# Windows
netstat -ano | findstr :3001
taskkill /PID <PID> /F

# macOS/Linux
lsof -ti:3001 | xargs kill -9
```

### WhatsApp não conecta
1. Limpe o cache: `rm -rf .wwebjs_auth .wwebjs_cache`
2. Reinicie o servidor: `npm run dev`
3. Tente conectar novamente
4. Verifique se não há outras instâncias do WhatsApp Web abertas

### Problemas de Performance
1. Aumente a memória disponível: `NODE_OPTIONS="--max-old-space-size=4096" npm run dev`
2. Verifique recursos do sistema: CPU e RAM
3. Feche aplicações desnecessárias

## 🛠️ Scripts Disponíveis

| Script | Descrição | Plataforma |
|--------|-----------|------------|
| `npm run setup` | Instalação completa cross-platform | Todas |
| `npm run dev` | Desenvolvimento (detecta plataforma) | Todas |
| `npm start` | Produção (detecta plataforma) | Todas |
| `npm run dev:windows` | Desenvolvimento específico Windows | Windows |
| `npm run dev:mac` | Desenvolvimento específico macOS | macOS |
| `npm run start:windows` | Produção específico Windows | Windows |
| `npm run start:mac` | Produção específico macOS | macOS |
| `npm run install:deps` | Instalar apenas dependências | Todas |
| `npm run install:chromium` | Baixar apenas Chromium | Todas |
| `npm test` | Executar testes | Todas |

## 🔧 Configuração Avançada

### Variáveis de Ambiente (.env)
```env
# Ambiente
NODE_ENV=development
PORT=3001
HOST=localhost

# MongoDB
MONGODB_URI=sua_conexao_mongodb

# Sessão
SESSION_SECRET=sua_chave_secreta

# Configurações específicas da plataforma (auto-detectadas)
PLATFORM=win32
IS_WINDOWS=true
IS_MAC=false
IS_LINUX=false
```

### Personalização do Puppeteer
O arquivo `platform-config.js` permite personalizar:
- Argumentos do Chromium por plataforma
- Caminhos de executáveis
- Configurações de timeout
- Parâmetros de performance

## 📞 Suporte

### Documentação
- [WhatsApp Web.js](https://wwebjs.dev/)
- [Node.js](https://nodejs.org/docs/)
- [MongoDB](https://docs.mongodb.com/)

### Comunidade
- [Issues](https://github.com/seu-usuario/clerky-crm/issues)
- [Discussions](https://github.com/seu-usuario/clerky-crm/discussions)

## 📄 Licença

Este projeto está licenciado sob a Licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

---

**Desenvolvido com ❤️ para funcionar perfeitamente em Windows, macOS e Linux**

🌟 **Gostou do projeto? Deixe uma estrela!** ⭐ 