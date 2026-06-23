/**
 * TMS GVR — Proxy de Cotação
 * Transportadoras: JAMEF | BRASPRESS
 *
 * Rodar: node server.js
 * Porta: http://localhost:3000
 */

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// CONFIGURAÇÃO API JAMEF OFICIAL
// ─────────────────────────────────────────────
const JAMEF_API = {
  host:     'api-qa.jamef.com.br',
  basePath: '/calculo-frete/v1',
  authPath: '/auth/v1/logins',      // POST /logins — status 201 confirma endpoint REST
  username: 'sistemas@jamef.com.br',
  password: '12343456',
  _token:   null,
  _tokenExp: 0
};

// Obtém token da API JAMEF (com cache)
async function jamefAPIToken() {
  // Retorna token em cache se ainda válido
  if (JAMEF_API._token && Date.now() < JAMEF_API._tokenExp) {
    return JAMEF_API._token;
  }

  const payload = JSON.stringify({
    username: JAMEF_API.username,
    password: JAMEF_API.password
  });

  const result = await httpsRequest({
    hostname: JAMEF_API.host,
    path:     JAMEF_API.authPath,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  console.log('[JAMEF API AUTH] Status:', result.status, 'Body:', result.body.slice(0, 200));

  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new Error('JAMEF API: resposta de auth inválida'); }

  if (result.status >= 400) {
    const detalhe = data.erros && data.erros[0] ? data.erros[0].detalhes : '';
    throw new Error('JAMEF API auth falhou: ' + (data.mensagem || detalhe || data.message || result.status));
  }

  // Estrutura confirmada: { situacao, dado: [{ accessToken, expiresIn }] }
  const token = (data.dado && data.dado[0] && data.dado[0].accessToken)
    || data.access_token || data.accessToken || data.token;

  if (!token) {
    console.log('[JAMEF API AUTH] Resposta completa:', JSON.stringify(data));
    throw new Error('JAMEF API: token não encontrado. Resposta: ' + JSON.stringify(data).slice(0,150));
  }

  const expiresIn = (data.dado && data.dado[0] && data.dado[0].expiresIn) || 3600;

  // Cache por 55 minutos (token dura 1h)
  JAMEF_API._token    = token;
  JAMEF_API._tokenExp = Date.now() + (expiresIn - 300) * 1000;
  console.log('[JAMEF API AUTH] Token obtido, expira em', expiresIn, 'segundos');
  return token;
}

// ─────────────────────────────────────────────
// CONFIGURAÇÃO GVR
// ─────────────────────────────────────────────
const GVR = {
  cnpj:          '66934555001514',
  cnpjFormatado: '66.934.555/0015-14',
  razaoSocial:   'GVR HOME INDUSTRIA E COMERCIO DE ENXOVAIS LTDA',
  nome:          'DIEGO SANTOS',
  telefone:      '(11) 3641-9847',
  email:         'diego.santos@trousseau.com.br'
};

// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  setCORS(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────
// LEITURA DO BODY
// ─────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end',  () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────
// REQUISIÇÃO HTTPS GENÉRICA
// ─────────────────────────────────────────────
function httpsRequest(options, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─────────────────────────────────────────────
// UTILITÁRIOS
// ─────────────────────────────────────────────
// Número BR → float: "18,40" → 18.40 | "1.409,60" → 1409.60
function brToFloat(v) {
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(/\./g, '').replace(',', '.')) || 0;
}

// Float → formato BR: 1409.6 → "1.409,60"
function floatToBR(v, dec = 2) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

// Formata CNPJ: "66934555001514" → "66.934.555/0015-14"
function formatCNPJ(v) {
  const d = String(v).replace(/\D/g, '').padStart(14, '0');
  return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
}

// Data de hoje: YYYYMMDD
function hoje() {
  const d = new Date();
  return d.getFullYear().toString() +
    String(d.getMonth()+1).padStart(2,'0') +
    String(d.getDate()).padStart(2,'0');
}
function horaAgora() {
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0');
}

// ═══════════════════════════════════════════════════════════════
//  ██  JAMEF
// ═══════════════════════════════════════════════════════════════

// ① Login JAMEF via AWS Cognito
async function jamefLogin(body) {
  // Endpoint real confirmado via DevTools: POST /api/auth/login
  const payload = JSON.stringify({
    email:    body.email,
    password: body.senha
  });

  const result = await httpsRequest({
    hostname: 'cliente.jamef.com.br',
    path:     '/api/auth/login',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      'Origin':         'https://cliente.jamef.com.br',
      'Referer':        'https://cliente.jamef.com.br/login',
      'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new Error('JAMEF retornou resposta inválida no login'); }

  if (result.status !== 200) {
    throw new Error(
      data.message || data.erro || data.error ||
      'E-mail ou senha JAMEF incorretos.'
    );
  }

  // Normaliza os tokens para o formato padrão
  // Verifica os campos possíveis que o portal pode retornar
  const idToken      = data.idToken      || data.IdToken      || data.token      || data.accessToken;
  const accessToken  = data.accessToken  || data.AccessToken  || data.token;
  const refreshToken = data.refreshToken || data.RefreshToken || null;
  const expiresIn    = data.expiresIn    || data.ExpiresIn    || 7200;

  // Log completo para debug
  console.log('[JAMEF LOGIN] Status:', result.status);
  console.log('[JAMEF LOGIN] Body completo:', JSON.stringify(data).slice(0, 500));

  if (!idToken) {
    // Verifica se é challenge MFA — campo challengeName indica MFA requerido
    const challengeName = data.challengeName || data.ChallengeName || '';
    const session       = data.session       || data.Session       || '';

    // Se não tem tokens mas tem session ou challengeName → MFA
    if (challengeName || session) {
      console.log('[JAMEF MFA] Challenge detectado:', challengeName, 'Session:', session.slice(0,20));
      return {
        mfaRequired:   true,
        ChallengeName: challengeName || 'EMAIL_MFA',
        Session:       session,
        _rawLogin:     data
      };
    }

    // Tenta todos os campos possíveis de session
    const allFields = JSON.stringify(data).toLowerCase();
    if (allFields.includes('session') || allFields.includes('mfa') || allFields.includes('challenge')) {
      const anySession = Object.values(data).find(v => typeof v === 'string' && v.length > 20) || '';
      console.log('[JAMEF MFA] Session inferida:', anySession.slice(0,30));
      return {
        mfaRequired:   true,
        ChallengeName: 'EMAIL_MFA',
        Session:       anySession,
        _rawLogin:     data
      };
    }

    throw new Error('JAMEF: ' + (data.message || data.erro || data.error || 'Resposta inesperada — body: ' + JSON.stringify(data).slice(0,100)));
  }

  return {
    IdToken:      idToken,
    AccessToken:  accessToken  || idToken,
    RefreshToken: refreshToken,
    ExpiresIn:    expiresIn,
    _rawLogin:    data  // preserva resposta completa para debug
  };
}

// ② Renovar token JAMEF
async function jamefRefresh(body) {
  const payload = JSON.stringify({
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: '75lv5or3fujfp3trhse7bh508m',
    AuthParameters: { REFRESH_TOKEN: body.refreshToken }
  });

  const result = await httpsRequest({
    hostname: 'cognito-idp.us-east-1.amazonaws.com',
    path: '/', method: 'POST',
    headers: {
      'Content-Type':   'application/x-amz-json-1.1',
      'X-Amz-Target':  'AWSCognitoIdentityProviderService.InitiateAuth',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  const data = JSON.parse(result.body);
  if (result.status !== 200) throw new Error('Sessão JAMEF expirada. Faça login novamente.');
  return data.AuthenticationResult;
}


// ③ MFA JAMEF — confirma código enviado por e-mail
// Endpoint confirmado: POST /api/auth/confirm-mfa
// Payload: { session, mfaCode, email, challengeName: "EMAIL_MFA" }
async function jamefMFA(body) {
  const payload = JSON.stringify({
    session:       body.session || '',
    mfaCode:       body.codigo,
    email:         body.email,
    challengeName: 'EMAIL_MFA'
  });

  const result = await httpsRequest({
    hostname: 'cliente.jamef.com.br',
    path:     '/api/auth/confirm-mfa',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      'Origin':         'https://cliente.jamef.com.br',
      'Referer':        'https://cliente.jamef.com.br/login',
      'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new Error('Resposta inválida no MFA JAMEF'); }

  console.log('[JAMEF MFA] Status:', result.status, 'Body:', JSON.stringify(data).slice(0,300));

  if (result.status >= 400) {
    throw new Error(data.message || data.erro || data.error || 'Código MFA inválido ou expirado.');
  }

  const idToken     = data.idToken     || data.IdToken     || data.token;
  const accessToken = data.accessToken || data.AccessToken || data.token;
  const refreshToken= data.refreshToken|| data.RefreshToken|| null;
  const expiresIn   = data.expiresIn   || data.ExpiresIn   || 7200;

  if (!idToken) {
    console.log('[JAMEF MFA] Resposta:', JSON.stringify(data).slice(0, 300));
    throw new Error('MFA OK mas tokens não retornados: ' + JSON.stringify(data).slice(0, 100));
  }

  return { IdToken: idToken, AccessToken: accessToken, RefreshToken: refreshToken, ExpiresIn: expiresIn };
}


// ③ Cotação JAMEF
async function jamefCotacao(campos) {
  // Usa API oficial JAMEF (api-qa.jamef.com.br)
  const token = await jamefAPIToken();

  const pesoReal   = Number(campos.pesoReal);
  const pesoCubado = Number(campos.pesoCubado ?? pesoReal);
  const pesoCobrado= Math.max(pesoReal, pesoCubado);

  // Calcula metragem cúbica a partir das dimensões
  const comp = Number(campos.comprimento) || 0;
  const larg = Number(campos.largura)     || 0;
  const alt  = Number(campos.altura)      || 0;
  const metragemCubica = comp > 0 && larg > 0 && alt > 0
    ? parseFloat((comp * larg * alt * Number(campos.qtdVolumes || 1)).toFixed(4))
    : parseFloat((pesoCubado / 300).toFixed(4));

  // Data de coleta = hoje
  const hoje = new Date();
  const dataColeta = String(hoje.getDate()).padStart(2,'0') + '/' +
                     String(hoje.getMonth()+1).padStart(2,'0') + '/' +
                     hoje.getFullYear();

  const payload = JSON.stringify({
    tipoTransporte:    campos.modal === 'A' ? '2' : '1',
    documentoDevedor:  GVR.cnpj,
    cepOrigem:         String(campos.cepOrigem).replace(/\D/g,'').padStart(8,'0'),
    cepDestino:        String(campos.cepDestino).replace(/\D/g,'').padStart(8,'0'),
    quantidadeVolume:  Number(campos.qtdVolumes) || 1,
    pesoMercadoria:    pesoCobrado,
    valorNotaFiscal:   Number(campos.valorMercadoria),
    metragemCubica:    metragemCubica,
    documentoRemetente: GVR.cnpj,
    documentoDestino:  String(campos.cnpjDestinatario).replace(/\D/g,''),
    filialOrigem:      '01',
    dataColeta:        dataColeta
  });

  console.log('[JAMEF API] Payload:', payload);

  const result = await httpsRequest({
    hostname: JAMEF_API.host,
    path:     JAMEF_API.basePath,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      'Authorization':  `Bearer ${token}`,
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  console.log('[JAMEF API] Status:', result.status, 'Body:', result.body.slice(0, 300));

  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new Error(`JAMEF API retornou resposta inválida (status ${result.status})`); }

  if (result.status >= 400) {
    // Formato de erro confirmado: { situacao, mensagem, erros: [{detalhes, componenteFalho}] }
    const detalhe = data.erros && data.erros[0] ? data.erros[0].detalhes : '';
    throw new Error(data.mensagem || detalhe || data.message || `Erro ${result.status} JAMEF API`);
  }

  // Status de sucesso é 201 (Created) na API JAMEF
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`JAMEF API retornou status inesperado: ${result.status}`);
  }

  // Normaliza resposta
  return {
    transportadora: 'JAMEF',
    numeroCotacao:  data.numeroCotacao || data.protocolo || data.id || '—',
    valorFrete:     data.valorFrete    ?? data.frete     ?? data.valor    ?? null,
    valorImpostos:  data.valorImpostos ?? data.impostos  ?? null,
    valorTotal:     data.valorTotal    ?? data.total     ?? data.valorFrete ?? null,
    prazoEntrega:   data.dataEntrega   ?? data.prazo     ?? data.dtEntrega  ?? null,
    diasUteis:      data.diasUteis     ?? data.prazoEntrega ?? null,
    pesoReal,
    pesoCubado,
    pesoCobrado,
    raw: data
  };
}


