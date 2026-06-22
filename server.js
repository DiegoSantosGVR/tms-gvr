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

const PORT = 3000;

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

  if (!idToken) {
    // Log da resposta para debug
    console.log('[JAMEF LOGIN] Resposta inesperada:', JSON.stringify(data).slice(0, 300));
    throw new Error('JAMEF login OK mas tokens não encontrados na resposta. Verifique os logs do servidor.');
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

// ③ Cotação JAMEF
async function jamefCotacao(campos) {
  const { idToken, accessToken } = campos;
  const pesoCubado = campos.pesoCubado ?? campos.pesoReal;

  const payload = JSON.stringify({
    dataCotacao:         hoje(),
    horaCotacao:         horaAgora(),
    cnpjCpfSolicitante:  GVR.cnpj,
    tipoFrete:           campos.tipoFrete    || '1',
    cnpjCpfRemetente:    GVR.cnpj,
    cnpjCpfDestinatario: String(campos.cnpjDestinatario).replace(/\D/g,''),
    cnpjCpfDevedor:      GVR.cnpj,
    produto:             campos.produto      || '010199',
    embalagem:           campos.embalagem    || 'CX',
    quantidadeVolume:    Number(campos.qtdVolumes) || 1,
    pesoReal:            Number(campos.pesoReal),
    pesoCubado:          Number(pesoCubado),
    valorMercadoria:     Number(campos.valorMercadoria),
    codigoRegiaoOrigem:  campos.regiaoOrigem,
    tipoTransporte:      campos.modal === 'A' ? '2' : '1',
    codigoRegiaoDestino: campos.regiaoDestino,
    volume: [{
      quantidadeVolume: Number(campos.qtdVolumes) || 1,
      altura:           Number(campos.altura)      || 1,
      largura:          Number(campos.largura)     || 1,
      comprimento:      Number(campos.comprimento) || 1
    }],
    nomeContato:     GVR.nome,
    telefoneContato: GVR.telefone
  });

  const result = await httpsRequest({
    hostname: 'cliente.jamef.com.br',
    path:     '/api/quotation',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Accept':         '*/*',
      'Origin':         'https://cliente.jamef.com.br',
      'Referer':        'https://cliente.jamef.com.br/cotacao',
      'Cookie':         `idToken=${idToken}; accessToken=${accessToken}`,
      'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new Error(`JAMEF retornou resposta inválida (status ${result.status})`); }

  if (result.status >= 400) throw new Error(data.message || `Erro ${result.status} JAMEF`);

  return {
    transportadora: 'JAMEF',
    numeroCotacao:  data.numeroCotacao || data.numero || data.id || '—',
    valorFrete:     data.valorFrete    ?? data.frete   ?? null,
    valorImpostos:  data.valorImpostos ?? data.impostos ?? null,
    valorTotal:     data.valorTotal    ?? data.total    ?? null,
    prazoEntrega:   data.dataEntrega   ?? data.prazo    ?? data.dtEntrega ?? null,
    pesoReal:       Number(campos.pesoReal),
    pesoCubado:     Number(pesoCubado),
    pesoCobrado:    Math.max(Number(campos.pesoReal), Number(pesoCubado)),
    raw: data
  };
}

// ═══════════════════════════════════════════════════════════════
//  ██  BRASPRESS
// ═══════════════════════════════════════════════════════════════

// Estado de sessão BRASPRESS (JSESSIONID em memória)
let bpSession = { jsessionid: null, email: null, senha: null };

// ① Login BRASPRESS — obtém JSESSIONID
async function braspressLogin(email, senha) {
  // O portal usa form login. Fazemos GET na página de cotação para obter o cookie de sessão.
  const result = await httpsRequest({
    hostname: 'blue.braspress.com',
    path:     '/site/w/cotacao/view',
    method:   'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept':     'text/html,application/xhtml+xml',
    }
  }, null);

  // Extrai JSESSIONID do Set-Cookie
  const cookies = result.headers['set-cookie'] || [];
  let jsessionid = null;
  for (const c of cookies) {
    const m = c.match(/JSESSIONID=([^;]+)/);
    if (m) { jsessionid = m[1]; break; }
  }

  // Se não veio no header, verifica se já tem uma sessão válida
  if (!jsessionid && bpSession.jsessionid) {
    jsessionid = bpSession.jsessionid;
  }

  if (!jsessionid) throw new Error('Não foi possível obter sessão BRASPRESS. O portal pode estar fora do ar.');

  bpSession = { jsessionid, email, senha };
  return jsessionid;
}

// ② getFilialByCEP — converte CEP em código de filial BRASPRESS
// Resposta confirmada: { idFilial: 1, sigla: "SAO", endereco: { cidade, uf, ... } }
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
  catch { throw new Error(`Erro ao buscar filial para CEP ${cepLimpo}`); }

  // Campo confirmado via DevTools: idFilial
  const filial = data.idFilial;
  if (!filial) throw new Error(`Filial BRASPRESS não encontrada para CEP ${cepLimpo}. Verifique se a região é atendida.`);

  const cidade   = data.endereco?.cidade || '';
  const uf       = data.endereco?.uf     || '';
  const endereco = cidade && uf ? `${cidade} - ${uf}` : '';

  return { filial: String(filial), endereco };
}

// ③ getCliente — busca razão social pelo CNPJ
async function braspressGetCliente(cnpjStr, jsessionid) {
  const result = await httpsRequest({
    hostname: 'blue.braspress.com',
    path:     `/site/w/cotacao/getCliente?cnpj=${encodeURIComponent(cnpjStr)}`,
    method:   'GET',
    headers: {
      'Accept':          '*/*',
      'X-Requested-With':'XMLHttpRequest',
      'Referer':         'https://blue.braspress.com/site/w/cotacao/view',
      'Cookie':          `JSESSIONID=${jsessionid}`,
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
  }, null);

  let data;
  try { data = JSON.parse(result.body); }
  catch { return { razaoSocial: '' }; }

  return { razaoSocial: data.razaoSocial || data.nome || data.nomeFantasia || '' };
}

// ④ Cotação BRASPRESS — fluxo completo
async function braspressCotacao(campos) {
  // Aceita jsessionid direto (copiado do portal) ou via sessão em memória
  let jsessionid = campos.jsessionid || bpSession.jsessionid;
  if (!jsessionid) throw new Error('JSESSIONID da BRASPRESS não informado. Copie do portal blue.braspress.com → F12 → Application → Cookies.');

  // Atualiza sessão em memória
  if (campos.jsessionid) bpSession.jsessionid = campos.jsessionid;

  const pesoReal   = Number(campos.pesoReal);
  const pesoCubado = Number(campos.pesoCubado ?? pesoReal);
  const pesoCobrado= Math.max(pesoReal, pesoCubado);
  const valor      = Number(campos.valorMercadoria);
  const qtd        = Number(campos.qtdVolumes) || 1;

  // Busca filiais em paralelo
  const [orig, dest, clienteDest] = await Promise.all([
    braspressGetFilial(campos.cepOrigem,  jsessionid),
    braspressGetFilial(campos.cepDestino, jsessionid),
    campos.cnpjDestinatario
      ? braspressGetCliente(formatCNPJ(campos.cnpjDestinatario), jsessionid)
      : Promise.resolve({ razaoSocial: '' })
  ]);

  // Monta payload form-urlencoded (exatamente como o portal envia)
  const params = new URLSearchParams();
  params.append('email',                   email);
  params.append('modal',                   campos.modal || 'R');
  params.append('tipoFrete',               campos.tipoFrete || '1');
  params.append('cnpjRemetenteStr',        GVR.cnpjFormatado);
  params.append('razaoSocialRemetente',    GVR.razaoSocial);
  params.append('cnpjDestinatarioStr',     formatCNPJ(campos.cnpjDestinatario));
  params.append('razaoSocialDestinatario', clienteDest.razaoSocial);
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
  // Dimensões — uma entrada por volume (BRASPRESS usa cubagem[N].campo)
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

  // Sessão expirada → tenta uma vez com login fresh
  if (result.status === 401 || result.status === 302) {
    jsessionid = await braspressLogin(email, senha);
    bpSession.jsessionid = jsessionid;
    // Retry
    return braspressCotacao(campos);
  }

  let data;
  try { data = JSON.parse(result.body); }
  catch { throw new Error(`BRASPRESS retornou resposta inválida (status ${result.status}): ${result.body.slice(0,200)}`); }

  if (result.status >= 400) throw new Error(data.message || data.erro || `Erro ${result.status} BRASPRESS`);

  // Normaliza resposta
  // Campos confirmados na imagem: Valor Total Frete, Dias úteis, Data Entrega Prevista, Protocolo
  const valorTotalRaw = data.valorTotalFrete ?? data.valorTotal ?? data.total ?? null;
  const prazo         = data.dataEntregaPrevista ?? data.dataEntrega ?? data.prazo ?? null;
  const diasUteis     = data.diasUteis ?? data.dias ?? null;
  const protocolo     = data.protocoloCotacaoOnline ?? data.protocolo ?? data.numeroCotacao ?? '—';

  return {
    transportadora: 'BRASPRESS',
    numeroCotacao:  String(protocolo),
    valorFrete:     valorTotalRaw != null ? brToFloat(valorTotalRaw) : null,
    valorImpostos:  null, // BRASPRESS inclui tudo no valor total
    valorTotal:     valorTotalRaw != null ? brToFloat(valorTotalRaw) : null,
    prazoEntrega:   prazo,
    diasUteis:      diasUteis,
    pesoReal,
    pesoCubado,
    pesoCobrado,
    raw: data
  };
}

// ═══════════════════════════════════════════════════════════════
//  ██  COTAÇÃO COMBINADA
// ═══════════════════════════════════════════════════════════════
async function cotacaoCombinada(body) {
  const promessas = [];

  if (body.jamef)      promessas.push(jamefCotacao(body.jamef).catch(e => ({ _erro: true, transportadora: 'JAMEF',     erro: e.message })));
  if (body.braspress)  promessas.push(braspressCotacao(body.braspress).catch(e => ({ _erro: true, transportadora: 'BRASPRESS', erro: e.message })));

  const todos = await Promise.all(promessas);

  const resultados = todos.filter(r => !r._erro);
  const erros      = todos.filter(r =>  r._erro).map(({ _erro, ...rest }) => rest);

  // Ordena por menor valor total
  resultados.sort((a, b) => (a.valorTotal ?? Infinity) - (b.valorTotal ?? Infinity));

  return { resultados, erros, total: todos.length };
}

// ═══════════════════════════════════════════════════════════════
//  ██  ROTEADOR HTTP
// ═══════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  if (req.method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }

  // Serve o index.html na raiz — corrige URL do proxy dinamicamente
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, 'utf-8');
      // Garante que o PROXY sempre aponta para a origem correta
      html = html.replace(
        /const PROXY = .*/,
        "const PROXY = window.location.origin;"
      );
      // Remove avisos de localhost que confundem o usuário
      html = html.replace(
        /<span[^>]*>Proxy local:.*?<\/span>/g,
        '<span style="font-size:12px;color:#1a7f4b">✅ tms-gvr.onrender.com</span>'
      );
      html = html.replace(
        /<div class="alert alert-info"[^>]*>\s*💡[^<]*<strong>node server\.js<\/strong>[^<]*<\/div>/g,
        ''
      );
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, { status: 'ok', versao: '1.2.0', transportadoras: ['JAMEF ✅', 'BRASPRESS ✅'] });
  }

  if (req.method !== 'POST') return json(res, 405, { erro: 'Método não permitido' });

  let body;
  try { body = await readBody(req); }
  catch { return json(res, 400, { erro: 'Body inválido' }); }

  try {
    // ── JAMEF ──
    if (pathname === '/api/jamef/login')   return json(res, 200, { ok: true, ...(await jamefLogin(body)) });
    if (pathname === '/api/jamef/refresh') return json(res, 200, { ok: true, ...(await jamefRefresh(body)) });
    if (pathname === '/api/jamef/cotacao') return json(res, 200, { ok: true, resultado: await jamefCotacao(body) });

    // ── BRASPRESS ──
    if (pathname === '/api/braspress/cotacao') return json(res, 200, { ok: true, resultado: await braspressCotacao(body) });

    // ── COMBINADA ──
    if (pathname === '/api/cotacao') return json(res, 200, { ok: true, ...(await cotacaoCombinada(body)) });

    return json(res, 404, { erro: 'Rota não encontrada' });

  } catch(e) {
    console.error(`[ERRO] ${pathname}:`, e.message);
    return json(res, 500, { ok: false, erro: e.message });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║   TMS GVR — Proxy de Cotação  v1.1   ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Rodando em http://localhost:${PORT}     ║`);
  console.log('  ╠══════════════════════════════════════╣');
  console.log('  ║  JAMEF    ✅  Cognito JWT             ║');
  console.log('  ║  BRASPRESS ✅  JSESSIONID             ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log('  ║  POST /api/cotacao  (combinada)      ║');
  console.log('  ║  POST /api/jamef/login               ║');
  console.log('  ║  POST /api/braspress/cotacao         ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
