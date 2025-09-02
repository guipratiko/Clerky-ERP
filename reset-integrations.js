#!/usr/bin/env node

/**
 * Script para resetar configurações de integração problemáticas
 * Remove URLs que causam erros de DNS
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Schema para Configurações de Integração
const integrationSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  n8nTestUrl: { type: String, default: '' },
  n8nProdUrl: { type: String, default: '' },
  n8nSentUrl: { type: String, default: '' },
  webhookReceiveUrl: { type: String, default: '' },
  iaEnabled: { type: Boolean, default: false },
  massDispatchBypass: { type: Boolean, default: true },
  useTestUrl: { type: Boolean, default: false },
  appmaxEnabled: { type: Boolean, default: false },
  appmaxApiKey: { type: String, default: '' },
  appmaxApiUrl: { type: String, default: '' },
  appmaxWebhookSecret: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now },
  updatedBy: String
});

const Integration = mongoose.model('Integration', integrationSchema);

async function resetIntegrations() {
  try {
    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado ao MongoDB!');
    
    // Buscar configuração atual
    const currentConfig = await Integration.findOne({ key: 'main' });
    
    if (currentConfig) {
      console.log('📋 Configuração atual encontrada:');
      console.log('  - n8nTestUrl:', currentConfig.n8nTestUrl);
      console.log('  - n8nProdUrl:', currentConfig.n8nProdUrl);
      console.log('  - n8nSentUrl:', currentConfig.n8nSentUrl);
      console.log('  - iaEnabled:', currentConfig.iaEnabled);
      
      // Verificar se há URLs problemáticas
      const hasProblematicUrls = 
        currentConfig.n8nTestUrl.includes('madeondemand') ||
        currentConfig.n8nProdUrl.includes('madeondemand') ||
        currentConfig.n8nSentUrl.includes('madeondemand');
      
      if (hasProblematicUrls) {
        console.log('⚠️  URLs problemáticas detectadas!');
        
        // Resetar para configurações seguras
        const safeConfig = {
          n8nTestUrl: '',
          n8nProdUrl: '',
          n8nSentUrl: '',
          webhookReceiveUrl: '',
          iaEnabled: false,
          massDispatchBypass: true,
          useTestUrl: false,
          appmaxEnabled: false,
          appmaxApiKey: '',
          appmaxApiUrl: '',
          appmaxWebhookSecret: '',
          updatedAt: new Date(),
          updatedBy: 'reset-script'
        };
        
        await Integration.findOneAndUpdate(
          { key: 'main' },
          safeConfig,
          { upsert: true, new: true }
        );
        
        console.log('✅ Configurações resetadas com sucesso!');
        console.log('🔧 IA desabilitada temporariamente');
        console.log('🌐 URLs problemáticas removidas');
      } else {
        console.log('✅ Nenhuma URL problemática encontrada');
      }
    } else {
      console.log('ℹ️  Nenhuma configuração encontrada');
    }
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Conexão fechada');
    process.exit(0);
  }
}

// Executar script
resetIntegrations();
