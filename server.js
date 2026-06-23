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
  authPath: '/auth/v1/login',
  username: 'diego.santos@trousseau.com.br',
  password: 'Trousseau123@',
  _token:   null,
  _tokenExp: 0
};

// Obtém token da API JAMEF (com cache)
async function jamefAPIToken() {
  if (JAMEF_API._token && Date.now() < JAMEF_API._tokenExp) {
    return JAMEF_API._token;
  }

  const payload = JSON.stringify({
    username: JAMEF_API.username,
    password: JAMEF_API.password
  });

  // Tenta múltiplos endpoints possíveis
  const authPaths = [
    '/auth/v1/login',    // confirmado no portal developers JAMEF
    '/auth/v1/logins',   // fallback
  ];

  let data, lastStatus;
  for (const authPath of authPaths) {
    const result = await httpsRequest({
      hostname: JAMEF_API.host,
      path:     authPath,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);

    console.log(`[JAMEF API AUTH] ${authPath} → Status:`, result.status, 'Body:', result.body.slice(0, 150));
    lastStatus = result.status;

    try { data = JSON.parse(result.body); } catch { continue; }

    // Sucesso se status 200 ou 201
    if (result.status === 200 || result.status === 201) break;
    // Não tenta mais se for 401 (credenciais erradas)
    if (result.status === 401) break;
    data = null;
  }

  if (!data || (lastStatus !== 200 && lastStatus !== 201)) {
    const detalhe = data?.erros?.[0]?.detalhes || '';
    throw new Error('JAMEF API auth falhou: ' + (data?.mensagem || detalhe || data?.message || `Status ${lastStatus}`));
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

  // Tenta múltiplos paths de cotação
  // Path confirmado nos logs: /calculo-frete/v1/cotacao (sem "s")
  const cotacaoPaths = [
    JAMEF_API.basePath + '/cotacao',
    JAMEF_API.basePath + '/cotacoes',
  ];

  let result, cotacaoPath;
  for (const tryPath of cotacaoPaths) {
    const tryResult = await httpsRequest({
      hostname: JAMEF_API.host,
      path:     tryPath,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'Authorization':  `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }, payload);
    console.log(`[JAMEF COTACAO] ${tryPath} →`, tryResult.status);
    if (tryResult.status !== 404) {
      result = tryResult;
      cotacaoPath = tryPath;
      break;
    }
  }

    if (!result) {
    throw new Error('JAMEF API: todos os endpoints retornaram 404. Verifique o path correto na documentação.');
  }


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

  // Normaliza resposta — estrutura confirmada: dado[0].{frete, imposto, total, previsaoEntrega}
  const dado = data.dado && data.dado[0] ? data.dado[0] : data;
  return {
    transportadora: 'JAMEF',
    numeroCotacao:  data.idCorrelacao || data.numeroCotacao || data.protocolo || '—',
    valorFrete:     dado.frete        ?? dado.valorFrete    ?? dado.valor     ?? null,
    valorImpostos:  dado.imposto      ?? dado.impostos      ?? null,
    valorTotal:     dado.total        ?? dado.valorTotal    ?? (dado.frete != null && dado.imposto != null ? dado.frete + dado.imposto : dado.frete) ?? null,
    prazoEntrega:   dado.previsaoEntrega ?? dado.dataEntrega ?? dado.prazo    ?? null,
    diasUteis:      dado.diasUteis    ?? null,
    modalidade:     dado.modalidadeTransporte || null,
    pesoReal,
    pesoCubado,
    pesoCobrado,
    raw: data
  };
}



// ═══════════════════════════════════════════════════════════════
//  ██  BRASPRESS
// ═══════════════════════════════════════════════════════════════
let bpSession = { jsessionid: null };

function floatToBR(v, dec = 2) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function formatCNPJ(v) {
  const d = String(v).replace(/\D/g, '').padStart(14, '0');
  return `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`;
}

async function braspressGetFilial(cep, jsessionid) {
  const cepLimpo = String(cep).replace(/\D/g,'');
  const bodyStr  = `cep=${cepLimpo}`;
  const result = await httpsRequest({
    hostname: 'blue.braspress.com',
    path:     '/site/ajax/getFilialByCEP',
    method:   'POST',
    headers: {
      'Content-Type':    'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept':          '*/*',
      'X-Requested-With':'XMLHttpRequest',
      'Origin':          'https://blue.braspress.com',
      'Referer':         'https://blue.braspress.com/site/w/cotacao/view',
      'Cookie':          `JSESSIONID=${jsessionid}`,
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Length':  Buffer.byteLength(bodyStr)
    }
  }, bodyStr);

  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new Error(`Erro ao buscar filial para CEP ${cepLimpo} (status ${result.status})`); }

  const filial = data.idFilial;
  if (!filial) throw new Error(`Filial BRASPRESS não encontrada para CEP ${cepLimpo}`);
  const cidade = data.endereco?.cidade || '';
  const uf     = data.endereco?.uf     || '';
  return { filial: String(filial), endereco: cidade && uf ? `${cidade} - ${uf}` : '' };
}

async function braspressCotacao(campos) {
  let jsessionid = campos.jsessionid && campos.jsessionid !== 'POPUP_AUTH'
    ? campos.jsessionid
    : bpSession.jsessionid;

  if (!jsessionid || jsessionid === 'POPUP_AUTH') {
    throw new Error('Sessão BRASPRESS não disponível. Faça login pelo popup da BRASPRESS e tente novamente.');
  }

  bpSession.jsessionid = jsessionid;

  const pesoReal    = Number(campos.pesoReal);
  const pesoCubado  = Number(campos.pesoCubado ?? pesoReal);
  const pesoCobrado = Math.max(pesoReal, pesoCubado);
  const valor       = Number(campos.valorMercadoria);
  const qtd         = Number(campos.qtdVolumes) || 1;

  const [orig, dest] = await Promise.all([
    braspressGetFilial(campos.cepOrigem,  jsessionid),
    braspressGetFilial(campos.cepDestino, jsessionid)
  ]);

  const GVR_CNPJ_FORMATADO = '66.934.555/0015-14';
  const GVR_RAZAO_SOCIAL   = 'GVR HOME INDUSTRIA E COMERCIO DE ENXOVAIS LTDA';
  const GVR_EMAIL          = 'diego.santos@trousseau.com.br';

  const params = new URLSearchParams();
  params.append('email',                   GVR_EMAIL);
  params.append('modal',                   campos.modal || 'R');
  params.append('tipoFrete',               campos.tipoFrete || '1');
  params.append('cnpjRemetenteStr',        GVR_CNPJ_FORMATADO);
  params.append('razaoSocialRemetente',    GVR_RAZAO_SOCIAL);
  params.append('cnpjDestinatarioStr',     formatCNPJ(campos.cnpjDestinatario));
  params.append('razaoSocialDestinatario', '');
  params.append('cnpjConsignadoStr',       '');
  params.append('razaoSocialConsignado',   '');
  params.append('cepOrigem',               String(campos.cepOrigem).replace(/\D/g,''));
  params.append('filialOrigem',            orig.filial);
  params.append('cepDestino',              String(campos.cepDestino).replace(/\D/g,''));
  params.append('filialDestino',           dest.filial);
  params.append('endereco',               dest.endereco);
  params.append('volumes',                String(qtd));
  params.append('peso',                   floatToBR(pesoCobrado));
  params.append('vlrMercadoria',          floatToBR(valor));
  params.append('cubagem[0].comprimento', floatToBR(Number(campos.comprimento) || 1));
  params.append('cubagem[0].largura',     floatToBR(Number(campos.largura)     || 1));
  params.append('cubagem[0].altura',      floatToBR(Number(campos.altura)      || 1));
  params.append('cubagem[0].volumes',     String(qtd));

  const bodyStr = params.toString();
  const result = await httpsRequest({
    hostname: 'blue.braspress.com',
    path:     '/site/w/cotacao/calcular',
    method:   'POST',
    headers: {
      'Content-Type':    'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept':          '*/*',
      'X-Requested-With':'XMLHttpRequest',
      'Origin':          'https://blue.braspress.com',
      'Referer':         'https://blue.braspress.com/site/w/cotacao/view',
      'Cookie':          `JSESSIONID=${jsessionid}`,
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Length':  Buffer.byteLength(bodyStr)
    }
  }, bodyStr);

  // BRASPRESS retorna HTML — tenta JSON primeiro, senão parseia HTML
  let data = null;
  try { data = JSON.parse(result.body); } catch { data = null; }

  if (result.status >= 400) {
    const msg = data ? (data.message || data.erro || `Erro ${result.status}`) : `Erro ${result.status} BRASPRESS`;
    throw new Error(msg);
  }

  // Se retornou JSON válido
  if (data) {
    const valorTotalRaw = data.valorTotalFrete ?? data.valorTotal ?? data.total ?? null;
    return {
      transportadora: 'BRASPRESS',
      numeroCotacao:  String(data.protocoloCotacaoOnline || data.protocolo || data.numeroCotacao || '—'),
      valorFrete:     valorTotalRaw != null ? Number(String(valorTotalRaw).replace(/\./g,'').replace(',','.')) : null,
      valorImpostos:  null,
      valorTotal:     valorTotalRaw != null ? Number(String(valorTotalRaw).replace(/\./g,'').replace(',','.')) : null,
      prazoEntrega:   data.dataEntregaPrevista ?? data.dataEntrega ?? data.prazo ?? null,
      diasUteis:      data.diasUteis ?? null,
      pesoReal, pesoCubado, pesoCobrado,
      raw: data
    };
  }

  // Parseia HTML da resposta BRASPRESS
  const rawHtml = result.body;
  // Guarda HTML renderizado para debug (remove tags para exibição)
  const htmlSemTags = rawHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  bpSession._lastHtml = htmlSemTags; // debug mostra texto limpo
  const html = htmlSemTags; // usa texto sem tags para os regex
  console.log('[BRASPRESS HTML length]', html.length);
  console.log('[BRASPRESS HTML sample]', html.slice(0, 500));

  // Extrai protocolo — "Protocolo da Cotação Online 363431246"
  const protMatch = html.match(/Protocolo da Cota[^\d]*(\d{6,})/i) ||
                    html.match(/protocolo[\s\S]{0,50}?(\d{6,})/i);
  const protocolo = protMatch ? protMatch[1] : '—';

  // Extrai valor total — "Valor Total Frete 402.95" (ponto como decimal, sem R$)
  // Garante pelo menos 3 dígitos antes do ponto (valor mínimo R$100)
  const valorMatch = html.match(/Valor Total Frete[\s\S]{0,30}?([\d]{2,}\.[\d]{2})(?![\d])/i);
  const valorStr   = valorMatch ? valorMatch[1] : null;
  const valorTotal = valorStr ? parseFloat(valorStr) : null;
  console.log('[BRASPRESS VALOR] Match:', valorStr, 'Total:', valorTotal);

  // Extrai prazo — "Thu Jun 25 00:00:00 BRT 2026"
  // Converte para dd/mm/yyyy
  // Prazo — "Thu Jun 25 00:00:00 BRT 2026"
  const mesesBP = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const prazoMatch = html.match(/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\w+)\s+(\d+)\s+[\d:]+\s+\w+\s+(\d{4}))/i);
  let prazo = null;
  if (prazoMatch) {
    const mes = mesesBP[prazoMatch[2]];
    const dia = parseInt(prazoMatch[3]);
    const ano = parseInt(prazoMatch[4]);
    if (mes !== undefined) {
      prazo = String(dia).padStart(2,'0') + '/' + String(mes+1).padStart(2,'0') + '/' + ano;
    }
  }
  console.log('[BRASPRESS PRAZO]', prazo);

  // Extrai dias úteis — "Dias úteis / Horas 2"
  const diasMatch = html.match(/Dias [uú]teis[^\d]{0,20}(\d+)/i);
  const diasUteis = diasMatch ? Number(diasMatch[1]) : null;

  if (!valorTotal && !prazo) {
    // Verifica se é página de sucesso sem dados visíveis
    if (html.includes('sucesso') || html.includes('Cotação realizada')) {
      return {
        transportadora: 'BRASPRESS',
        numeroCotacao:  protocolo,
        valorFrete:     null,
        valorImpostos:  null,
        valorTotal:     null,
        prazoEntrega:   prazo,
        diasUteis,
        pesoReal, pesoCubado, pesoCobrado,
        mensagem:       'Cotação realizada — dados enviados por e-mail. Verifique seu e-mail para o valor.',
        raw:            { html: html.slice(0, 2000) }
      };
    }
    throw new Error('BRASPRESS: sessão expirada ou resposta inesperada. Faça login novamente no popup.');
  }

  return {
    transportadora: 'BRASPRESS',
    numeroCotacao:  protocolo,
    valorFrete:     valorTotal,
    valorImpostos:  null,
    valorTotal:     valorTotal,
    prazoEntrega:   prazo,
    diasUteis,
    pesoReal, pesoCubado, pesoCobrado,
    raw: { html: html.slice(0, 2000) }
  };
}


// ═══════════════════════════════════════════════════════════════
//  ROTEADOR HTTP
// ═══════════════════════════════════════════════════════════════
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }

  // Serve index.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    // Tenta múltiplos caminhos possíveis
    const possiblePaths = [
      '/opt/render/project/src/index.html',
      path.join(process.cwd(), 'index.html'),
      path.join(__dirname, 'index.html')
    ];
    console.log('[INDEX] __dirname:', __dirname, 'cwd:', process.cwd());
    let filePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) { filePath = p; break; }
    }
    if (filePath) {
      let html = fs.readFileSync(filePath, 'utf-8');
      html = html.replace(/const PROXY = .*/,  "const PROXY = window.location.origin;");
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      console.log('[INDEX] Não encontrado. Tentados:', possiblePaths);
      res.writeHead(404); res.end('index.html not found — paths: ' + possiblePaths.join(', '));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, { status: 'ok', versao: '2.1.0', transportadoras: ['JAMEF ✅', 'BRASPRESS ✅'] });
  }

  // Rotas GET especiais
  if (req.method === 'GET' && pathname === '/api/braspress/debug') {
    const html = bpSession._lastHtml || 'Nenhuma resposta BRASPRESS ainda — faça uma cotação primeiro.';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { erro: 'Body inválido' }); }

  try {
    // BRASPRESS
    if (pathname === '/api/braspress/session') {
      return json(res, 200, { jsessionid: bpSession.jsessionid || null });
    }
    if (pathname === '/api/braspress/cotacao') {
      return json(res, 200, { ok: true, resultado: await braspressCotacao(body) });
    }

    // JAMEF
    if (pathname === '/api/jamef/session') {
      return json(res, 200, { idToken: null });
    }

    // COTAÇÃO COMBINADA
    if (pathname === '/api/cotacao') {
      const promessas = [];
      if (body.jamef)     promessas.push(jamefCotacao(body.jamef).catch(e => ({ _erro: true, transportadora: 'JAMEF',     erro: e.message })));
      if (body.braspress) promessas.push(braspressCotacao(body.braspress).catch(e => ({ _erro: true, transportadora: 'BRASPRESS', erro: e.message })));
      const todos     = await Promise.all(promessas);
      const resultados = todos.filter(r => !r._erro);
      const erros      = todos.filter(r =>  r._erro).map(({ _erro, ...rest }) => rest);
      resultados.sort((a, b) => (a.valorTotal ?? Infinity) - (b.valorTotal ?? Infinity));
      return json(res, 200, { ok: true, resultados, erros });
    }

    return json(res, 404, { erro: 'Rota não encontrada' });

  } catch(e) {
    console.error(`[ERRO] ${pathname}:`, e.message);
    return json(res, 500, { ok: false, erro: e.message });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   TMS GVR — Proxy de Cotação  v2.0   ║');
  console.log(`  ║   Porta: ${PORT}                        ║`);
  console.log('  ║   JAMEF API Oficial ✅                ║');
  console.log('  ║   BRASPRESS via sessão ✅             ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
