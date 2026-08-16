
(function () {
  "use strict";

  let ttPolicy;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try { ttPolicy = window.trustedTypes.createPolicy("yt-blocker-policy", { createHTML: (s) => s }); } catch (e) {}
  }
  function safeHTML(html) { return ttPolicy ? ttPolicy.createHTML(html) : html; }

  // ===========================================================
  // ARMAZENAMENTO (substitui GM_getValue/GM_setValue, que não
  // existem no Webview Kiosk — aqui usamos localStorage, nativo
  // de qualquer navegador/webview)
  // ===========================================================
  const STORAGE_PREFIX = "ytBlocker_";
  function GM_getValue(key, defaultValue) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? defaultValue : JSON.parse(raw);
    } catch (e) {
      return defaultValue;
    }
  }
  function GM_setValue(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    } catch (e) {
      // se estourar limite de armazenamento, ignora silenciosamente
    }
  }

  const STORAGE_KEY_TITLES = "blockedTitleKeywords";
  const STORAGE_KEY_CHANNELS = "blockedChannelNames";
  const STORAGE_KEY_HIDE_ONLY = "hideOnlyMode";
  const STORAGE_KEY_ULTIMA_ATT_GITHUB = "ultimaAtualizacaoGithub";

  // =========================================================
  // CONFIGURAÇÃO DE ATUALIZAÇÃO REMOTA VIA GITHUB
  // =========================================================
  // Como montar (uma vez só):
  //   1. Crie um repositório no GitHub (pode ser público — só vai ter
  //      palavra-chave e nome de canal, nada sensível). Pode ser pelo
  //      app do celular mesmo.
  //   2. Crie 2 arquivos de texto simples nele, ex: titulos.txt e
  //      canais.txt, um item por linha.
  //   3. Abra cada arquivo no GitHub, clique em "Raw", e copie a URL
  //      (algo como https://raw.githubusercontent.com/SEU_USUARIO/
  //      SEU_REPO/main/titulos.txt) e cole abaixo.
  //   4. Pra atualizar de longe: edite o arquivo direto pelo app do
  //      GitHub ou pelo site, no celular ou no computador — o script
  //      busca o conteúdo mais recente automaticamente.
  //   Se preferir repositório PRIVADO, dá pra usar um token de acesso
  //   pessoal do GitHub (Settings > Developer settings > Personal
  //   access tokens, com permissão só de leitura) e trocar a função
  //   buscarConteudoGitHub abaixo pra mandar o header
  //   "Authorization: token SEU_TOKEN" — não configurei isso por
  //   padrão pra manter simples, já que o conteúdo não é sensível.
  const GITHUB_URL_TITULOS = "https://raw.githubusercontent.com/Fabricio1949/filtro-youtube-config/refs/heads/main/titulos.txt";
  const GITHUB_URL_CANAIS = "https://raw.githubusercontent.com/Fabricio1949/filtro-youtube-config/refs/heads/main/canais.txt";
  const GITHUB_ATUALIZAR_A_CADA_MS = 10 * 60 * 1000; // 10 minutos
  const GITHUB_ATIVO = GITHUB_URL_TITULOS !== "COLE_AQUI_A_URL_RAW_DO_ARQUIVO_DE_TITULOS";

  let processedKeywordSets = [];
  let blockedChannelNamesRaw = [];      // como o usuário digitou (pra reexibir na textarea)
  let blockedChannelNamesPreparados = []; // { normal, slug } — usado na comparação
  let lastRightClickedName = null;
  let lastRightClickedTitle = null;
  let hideOnlyMode = false;

  // ===========================================================
  // NORMALIZAÇÃO DE NOME DE CANAL (correção do bug de bloqueio)
  // ===========================================================
  // Compara em duas formas ao mesmo tempo: "normal" (minúsculo, sem
  // acento, com espaço) e "slug" (igual, mas sem espaço nenhum) —
  // assim bate tanto se você digitar o nome de exibição ("Canal Da
  // Vovó") quanto o handle ("canaldavovo").
  function normalizarTexto(txt) {
    if (!txt) return "";
    let t = txt.toLowerCase();
    t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    t = t.replace(/^@/, "");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }
  function prepararTermoCanal(bruto) {
    const normal = normalizarTexto(bruto);
    return { normal, slug: normal.replace(/\s+/g, "") };
  }
  function nomeDoCanalBateComBloqueados(nomesBrutos) {
    if (!nomesBrutos || !nomesBrutos.length || !blockedChannelNamesPreparados.length) return false;
    const candidatos = nomesBrutos.map(prepararTermoCanal);
    return candidatos.some((cand) =>
      blockedChannelNamesPreparados.some((bloq) => {
        if (!cand.normal || !bloq.normal) return false;
        const bateNormal = cand.normal.includes(bloq.normal) || bloq.normal.includes(cand.normal);
        const bateSlug = cand.slug.includes(bloq.slug) || bloq.slug.includes(cand.slug);
        return bateNormal || bateSlug;
      })
    );
  }

  // ===========================================================
  // MOTOR HEURÍSTICO (pesos — camada adicional além do bloqueio manual)
  // ===========================================================

  const FiltroHeuristico = (function () {
    function normalizar(texto) {
      if (!texto) return "";
      let t = texto.toLowerCase();
      t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      t = t.replace(/-/g, " ");
      t = t.replace(/[^\w\s]/g, " ");
      t = t.replace(/(.)\1{2,}/g, "$1$1");
      t = t.replace(/\s+/g, " ").trim();
      return t;
    }

    const RELIGIOSO = {
      generico: { peso: 1, termos: ["profecia", "profecias", "profetico", "profetica", "deus", "jesus", "igreja", "fe", "biblia"] },
      revelacaoFamilia: { peso: 4, termos: ["revelacao", "revelacoes", "revelou", "revelando", "revelar", "revelado", "revelada", "revelados", "reveladas", "revele", "revelarei", "revelara", "revelaram", "revelaria"] },
      revelacaoReligiosa: { peso: 2.5, termos: ["revelacao divina", "revelacao de deus", "revelacao biblica", "revelacao profetica", "deus revelou", "deus me revelou", "deus esta revelando", "foi revelado", "foi revelada", "visao de deus", "visao profetica", "mensagem de deus", "mensagem profetica", "mensagem do ceu", "mensagem divina"] },
      revelacaoFutura: { peso: 5, termos: ["deus revelou o que vai acontecer", "deus revelou o futuro", "deus mostrou o futuro", "deus mostrou o que vai acontecer", "deus revelou o que acontecera", "jesus revelou", "jesus mostrou", "visao do futuro", "sonho profetico", "sonho revelador", "sonho de deus"] },
      apocalipse: { peso: 4, termos: ["arrebatamento", "arrebatamento secreto", "fim dos tempos", "fim do mundo", "ultimos dias", "ultimo dia", "grande tribulacao", "tribulacao", "anticristo", "anti cristo", "marca da besta", "numero da besta", "666", "armagedom", "apocalipse", "juizo final", "volta de jesus", "volta de cristo", "segunda vinda", "segunda volta", "vinda de cristo", "retorno de jesus", "retorno de cristo", "sinais do fim", "sinais dos tempos", "sinais da volta", "sinais da vinda", "sinais profeticos", "sinais biblicos", "profecia do fim", "profecia dos ultimos dias"] },
      profeciaCombinada: { peso: 4, termos: ["profecia biblica", "profecia sobre o futuro", "profecia sobre o fim", "profecia se cumprindo", "profecia esta se cumprindo", "profecia vai acontecer"] },
      alertaMedo: { peso: 3, termos: ["alerta urgente", "alerta espiritual", "alerta de deus", "aviso de deus", "aviso urgente", "atencao urgente", "cuidado espiritual", "nao ignore isso", "nao assista", "pare agora", "deus esta avisando", "deus esta alertando", "deus mandou avisar", "deus quer te avisar", "antes que seja tarde", "antes que seja tarde demais", "isso nao e coincidencia", "nao aconteceu por acaso"] },
      guerraEspiritual: { peso: 3, termos: ["guerra espiritual", "batalha espiritual", "batalha contra o inimigo", "ataque espiritual", "ataques espirituais", "ataque do inimigo", "espirito maligno", "espiritos malignos", "espirito imundo", "opressao espiritual", "inimigo esta agindo", "satanas esta agindo", "satanas esta atacando", "obra do inimigo", "armadilha do inimigo"] },
      demonios: { peso: 2, termos: ["demonio", "demonios", "demoniaco", "demoniaca", "satanas", "diabo", "possessao", "possesso", "legiao", "encosto espiritual"] },
      demoniosContextualizados: { peso: 4, termos: ["demonio na sua casa", "demonios na sua vida", "demonio esta agindo", "ataque de demonio"] },
      bruxaria: { peso: 4, termos: ["pombagira", "pomba gira", "feiticeira", "feiticeiro", "feitico", "feiticaria", "bruxa", "bruxo", "bruxaria", "macumba", "macumbeiro", "macumbeira", "maldicao", "amaldicoado", "amaldicoada", "magia negra", "ocultismo", "ocultista"] },
      linguagemChamativaPessoal: { peso: 1, termos: ["guerreira", "doida", "mulamba"] },
      amarracao: { peso: 3, termos: ["amarracao", "amarracao amorosa", "desfazer amarracao", "amarracao desfeita", "trabalho de amarracao", "feitico de amor", "ervas magicas", "amarracao do amor", "quebrar amarracao"] },
      invejaEspiritual: { peso: 3, termos: ["inveja espiritual", "sinais de inveja", "alvo de inveja", "ataque de inveja", "inveja sobre voce", "inveja na sua casa", "inveja no seu relacionamento", "sofrendo inveja", "inveja contra voce", "vitima de inveja"] },
      vigilanciaMistica: { peso: 5, termos: ["homem te vigiando", "homem te observando", "tem um homem te vigiando", "tem um homem te observando", "alguem te observando", "voce esta sendo observada", "voce esta sendo vigiada", "ele esta te observando", "ele vai te procurar", "tem alguem de olho em voce", "esse homem esta te observando", "um homem te observando", "vigiando tua casa", "te vigiando", "alguem esta de olho em voce", "tem alguem pensando em voce"] },
      culturalBaixoPeso: { peso: 0.5, termos: ["umbanda", "candomble", "exu", "orixa"] },
      pronomesContextualizados: { peso: 4, termos: ["voce esta em perigo", "voce precisa saber", "voce precisa ouvir", "voce esta sendo atacado", "voce esta sendo enganado", "sua casa esta em perigo", "sua vida esta sendo atacada", "seu inimigo esta agindo", "seus inimigos estao agindo"] }
    };

    const GOLPE_IA = {
      declaracaoDireta: { peso: 5, termos: ["vou casar com voce", "vou casar com a senhora", "quero casar com voce", "quero casar com a senhora", "vou te buscar", "estou indo te buscar", "vou ate voce", "vou te levar comigo", "onde voce esta eu vou ate voce", "eu vou te encontrar", "eu vou ate sua casa"] },
      possessaoRomantica: { peso: 4, termos: ["voce e a mulher da minha vida", "voce e minha rainha", "eu nunca vou te abandonar", "eu vou cuidar de voce", "eu te amo senhora", "senhora eu te amo", "voce merece ser amada", "eu escolhi voce", "voce e minha escolhida", "fui escolhido pra voce", "deus te escolheu pra mim"] },
      isolamentoDesqualificacaoFamilia: { peso: 5, termos: ["seu filho nao liga pra voce", "sua familia nao te da valor", "ninguem cuida de voce como eu", "seu marido nao te merece", "seu marido vai se arrepender", "eles nao sabem o que voce vale", "voce esta sozinha mas eu estou aqui"] },
      generico: { peso: 1, termos: ["eu te amo", "minha rainha", "meu amor", "voce e linda", "voce e especial"] }
    };

    const INTENSIFICADORES = { peso: 1, termos: ["urgente", "urgentemente", "chocante", "chocou", "inacreditavel", "assustador", "assustadora", "terrivel", "surpreendente", "ninguem esperava", "voce nao vai acreditar", "ultima chance", "ultimo aviso", "alerta maximo"] };

    const EXCECOES = { peso: -3, termos: ["historia do cristianismo", "historia das religioes", "historia da igreja", "estudo biblico", "teologia", "teologia crista", "arqueologia biblica", "historia biblica", "contexto historico da biblia", "documentario sobre religiao", "documentario", "antropologia", "sociologia", "pesquisa academica", "estudo academico", "universidade", "artigo cientifico", "analise historica", "contexto historico", "entrevista", "debate", "aula sobre", "stalker", "codigo penal", "artigo 147", "boletim de ocorrencia", "delegacia", "como se proteger", "direitos da vitima", "psicologo", "psicologa", "crm", "seguranca publica", "lei maria da penha", "advogado"] };

    const COMBINACOES = [
      { pares: ["profecia", "fim"], bonus: 3 }, { pares: ["profecia", "futuro"], bonus: 3 },
      { pares: ["revelacao", "futuro"], bonus: 3 }, { pares: ["revelacao", "apocalipse"], bonus: 4 },
      { pares: ["alerta", "espiritual"], bonus: 3 }, { pares: ["sinais", "fim"], bonus: 3 },
      { pares: ["demonio", "casa"], bonus: 4 }, { pares: ["demonio", "vida"], bonus: 4 },
      { pares: ["guerra", "espiritual"], bonus: 3 }, { pares: ["macumba", "voce"], bonus: 4 },
      { pares: ["feitico", "voce"], bonus: 4 }, { pares: ["vou", "buscar"], bonus: 3 },
      { pares: ["casar", "senhora"], bonus: 4 }, { pares: ["amo", "senhora"], bonus: 3 },
      { pares: ["marido", "arrepender"], bonus: 4 }, { pares: ["sozinha", "aqui"], bonus: 3 }
    ];

    const PADROES_ORDEM = [
      { antes: "revelacao", depois: "fim", bonus: 2 }, { antes: "profecia", depois: "fim", bonus: 2 },
      { antes: "deus revelou", depois: "acontecer", bonus: 3 }, { antes: "alerta", depois: "arrebatamento", bonus: 3 },
      { antes: "vou", depois: "buscar", bonus: 2 }, { antes: "casar", depois: "senhora", bonus: 2 }
    ];

    // combinação por GRUPO: basta um termo de cada lado aparecer em
    // qualquer lugar do texto — pega "termo divino" + "direcionado a
    // você" mesmo com frases diferentes das listadas em COMBINACOES
    const GRUPOS_COMBINADOS = [
      {
        grupoA: ["deus", "jesus", "revelacao", "revelou", "revelando", "revelado", "revelada", "profecia", "profetica", "mensagem de deus", "palavra de deus", "confirmacao de deus", "recado do ceu", "aviso de deus", "alerta de deus", "guerreira de deus", "guerreiro de deus", "palavra profetica"],
        grupoB: ["pra voce", "pra tua vida", "pra sua vida", "e o seu", "diretamente pra voce", "hoje pra voce", "pra voce hoje", "e pra voce", "pra voce guerreira", "pra voce guerreiro"],
        bonus: 5
      },
      {
        grupoA: ["sinais", "sintomas", "sintoma", "energia", "olho gordo", "atacando", "atacada"],
        grupoB: ["inveja", "invejoso", "invejosa", "invejosos", "invejosas", "invejado", "invejada", "invejam"],
        bonus: 4
      }
    ];

    function contarOcorrencias(texto, termo) {
      const escaped = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("(?:^|\\s)" + escaped + "(?:\\s|$)", "g");
      const matches = texto.match(re);
      return matches ? matches.length : 0;
    }
    function analisarGrupo(texto, grupo, motivos) {
      let pontos = 0;
      for (const termo of grupo.termos) {
        const ocorrencias = contarOcorrencias(texto, termo);
        if (ocorrencias > 0) {
          const soma = grupo.peso * ocorrencias;
          pontos += soma;
          motivos.push(`${termo} (${soma > 0 ? "+" : ""}${soma})`);
        }
      }
      return pontos;
    }
    function analisarGruposCombinados(texto, motivos) {
      let pontos = 0;
      for (const grupo of GRUPOS_COMBINADOS) {
        const temA = grupo.grupoA.some((t) => texto.includes(t));
        const temB = grupo.grupoB.some((t) => texto.includes(t));
        if (temA && temB) {
          pontos += grupo.bonus;
          motivos.push(`grupo combinado: termo divino + direcionado a voce (+${grupo.bonus})`);
        }
      }
      return pontos;
    }
    function analisarCombinacoes(texto, motivos) {
      let pontos = 0;
      for (const combo of COMBINACOES) {
        if (combo.pares.every((p) => texto.includes(p))) {
          pontos += combo.bonus;
          motivos.push(`combinacao: ${combo.pares.join(" + ")} (+${combo.bonus})`);
        }
      }
      return pontos;
    }
    function analisarOrdemTitulo(titulo, motivos) {
      if (!titulo) return 0;
      let pontos = 0;
      for (const padrao of PADROES_ORDEM) {
        const idxAntes = titulo.indexOf(padrao.antes);
        const idxDepois = titulo.indexOf(padrao.depois);
        if (idxAntes === -1 || idxDepois === -1) continue;
        if (idxDepois <= idxAntes) continue;
        const trechoEntre = titulo.slice(idxAntes, idxDepois).split(" ").length;
        if (trechoEntre <= 12) {
          pontos += padrao.bonus;
          motivos.push(`ordem no titulo: "${padrao.antes}" antes de "${padrao.depois}" (+${padrao.bonus})`);
        }
      }
      return pontos;
    }

    const CONFIG_PADRAO = { limiteSuspeito: 3, limiteProvavel: 5, limiteBloqueio: 6 };

    function analisarTexto(texto, opcoes) {
      const config = Object.assign({}, CONFIG_PADRAO, opcoes);
      const normalizado = normalizar(texto);
      const motivos = [];
      let pontuacao = 0;
      for (const chave in RELIGIOSO) pontuacao += analisarGrupo(normalizado, RELIGIOSO[chave], motivos);
      for (const chave in GOLPE_IA) pontuacao += analisarGrupo(normalizado, GOLPE_IA[chave], motivos);
      pontuacao += analisarGrupo(normalizado, INTENSIFICADORES, motivos);
      pontuacao += analisarGrupo(normalizado, EXCECOES, motivos);
      pontuacao += analisarCombinacoes(normalizado, motivos);
      pontuacao += analisarGruposCombinados(normalizado, motivos);
      pontuacao += analisarOrdemTitulo(normalizado, motivos);
      pontuacao = Math.round(pontuacao * 100) / 100;
      let classificacao = "CONTEUDO_NORMAL";
      if (pontuacao >= config.limiteBloqueio) classificacao = "BLOQUEAR";
      else if (pontuacao >= config.limiteProvavel) classificacao = "PROVAVEL_SENSACIONALISMO";
      else if (pontuacao >= config.limiteSuspeito) classificacao = "SUSPEITO";
      return { pontuacao, classificacao, bloquear: pontuacao >= config.limiteBloqueio, motivos };
    }

    const PESO_FONTE = { titulo: 1.5, descricao: 0.75, canal: 0.5, hashtags: 0.6 };

    function analisarVideo(dados, opcoes) {
      const partes = [
        { texto: dados.titulo, fonte: "titulo" }, { texto: dados.descricao, fonte: "descricao" },
        { texto: dados.canal, fonte: "canal" }, { texto: dados.hashtags, fonte: "hashtags" }
      ];
      let pontuacaoTotal = 0;
      let motivosTotal = [];
      for (const parte of partes) {
        if (!parte.texto) continue;
        const resultado = analisarTexto(parte.texto, opcoes);
        const multiplicador = PESO_FONTE[parte.fonte] || 1;
        const pontosAjustados = Math.round(resultado.pontuacao * multiplicador * 100) / 100;
        pontuacaoTotal += pontosAjustados;
        if (resultado.motivos.length > 0) motivosTotal.push(`[${parte.fonte} x${multiplicador}] ` + resultado.motivos.join(", "));
      }
      const config = Object.assign({}, CONFIG_PADRAO, opcoes);
      pontuacaoTotal = Math.round(pontuacaoTotal * 100) / 100;
      let classificacao = "CONTEUDO_NORMAL";
      if (pontuacaoTotal >= config.limiteBloqueio) classificacao = "BLOQUEAR";
      else if (pontuacaoTotal >= config.limiteProvavel) classificacao = "PROVAVEL_SENSACIONALISMO";
      else if (pontuacaoTotal >= config.limiteSuspeito) classificacao = "SUSPEITO";
      return { pontuacao: pontuacaoTotal, classificacao, bloquear: pontuacaoTotal >= config.limiteBloqueio, motivos: motivosTotal };
    }

    return { normalizar, analisarTexto, analisarVideo, CONFIG_PADRAO };
  })();

  const MODO_DIAGNOSTICO = true;

  // ===========================================================
  // ESTILOS (modal, zona secreta, ocultação)
  // ===========================================================

  const HEADER_BUTTON_ID = "yt-blocker-header-btn";

  function GM_addStyle(css) {
    const style = document.createElement("style");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  GM_addStyle(`
      #yt-blocker-settings {
          position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
          background: rgba(0,0,0,0.75); z-index: 99999; display: none;
          align-items: center; justify-content: center; font-family: "Roboto", "Arial", sans-serif;
      }
      #yt-blocker-settings-content {
          background: #282828; color: #fff; border-radius: 14px;
          padding: 24px; width: 90%; max-width: 620px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      }
      #yt-blocker-settings-content h2 { font-size: 20px; font-weight: 600; margin: 0 0 20px 0; }
      .yt-blocker-section-title { font-size: 16px; font-weight: 600; margin: 14px 0 4px; }
      .yt-blocker-section-desc { font-size: 13px; color: #aaa; margin-bottom: 8px; line-height: 1.4; }
      .yt-blocker-textarea {
          width: 100%; height: 160px; background: #1f1f1f; color: #fff;
          border: 1px solid #555; border-radius: 8px; padding: 10px;
          font-family: monospace; font-size: 14px; resize: vertical;
      }
      .yt-blocker-settings-buttons { display: flex; justify-content: flex-end; margin-top: 20px; gap: 12px; }
      .yt-blocker-settings-btn { padding: 10px 22px; border: none; border-radius: 20px; cursor: pointer; font-weight: 600; font-size: 14px; }
      .yt-blocker-btn-cancel { background: #3a3a3a; color: #fff; }
      .yt-blocker-btn-save { background: #3ea6ff; color: #000; }
      #${HEADER_BUTTON_ID} { display: none !important; }
      @media (max-width: 480px) {
          #yt-blocker-settings-content { width: 92vw; max-height: 85vh; overflow-y: auto; padding: 16px; }
          .yt-blocker-textarea { height: 110px; }
      }
      #yt-blocker-secret-zone {
          position: fixed; top: 0; left: 0; width: 80px; height: 80px;
          z-index: 2147483647; background: transparent; touch-action: manipulation;
      }
      .yt-blocker-remove { display: none !important; }
      .yt-blocker-invisible { visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }
  `);

  // ===========================================================
  // SELETORES DE CARD (lista completa — inclui resultados de
  // canal na busca, que também precisam respeitar o bloqueio)
  // ===========================================================

  const CARD_SELECTOR = [
    "yt-lockup-view-model", "yt-lockup-metadata-view-model", "ytd-rich-item-renderer",
    "ytd-video-renderer", "ytm-rich-item-renderer", "ytm-video-with-context-renderer",
    "ytm-compact-video-renderer", "ytm-media-item", "ytm-shorts-lockup-view-model-v2",
    "ytm-shorts-lockup-view-model", "ytm-reel-item-renderer", "ytd-reel-item-renderer",
    "ytd-rich-shelf-renderer ytd-rich-item-renderer", "ytd-channel-renderer",
    "ytm-channel-renderer", "ytm-people-renderer", "ytd-people-renderer"
  ].join(", ");

  function stripQuotes(str) {
    str = str.trim();
    if (str.startsWith('"') && str.endsWith('"')) return str.slice(1, -1);
    return str;
  }

  // ===========================================================
  // MODAL DE CONFIGURAÇÕES
  // ===========================================================

  function openSettingsModal() {
    let modal = document.getElementById("yt-blocker-settings");
    if (!modal) {
      const html = `
          <div id="yt-blocker-settings">
              <div id="yt-blocker-settings-content">
                  <h2>Configurações do Filtro</h2>
                  <div class="yt-blocker-section-title">Ações rápidas</div>
                  <div class="yt-blocker-section-desc">Se você estiver dentro de um vídeo ou canal agora, pode bloquear direto daqui.</div>
                  <div class="yt-blocker-settings-buttons" style="justify-content:flex-start;margin-top:0;margin-bottom:16px;">
                      <button id="yt-blocker-block-channel-now" class="yt-blocker-settings-btn yt-blocker-btn-cancel">Bloquear canal atual</button>
                      <button id="yt-blocker-block-video-now" class="yt-blocker-settings-btn yt-blocker-btn-cancel">Bloquear vídeo atual</button>
                      <button id="yt-blocker-update-github" class="yt-blocker-settings-btn yt-blocker-btn-cancel">Atualizar do GitHub</button>
                  </div>

                  <div class="yt-blocker-section-title">Bloquear por palavras no título</div>
                  <div class="yt-blocker-section-desc">Uma linha por conjunto (ex: vlog diario). Bloqueia se TODAS as palavras da linha estiverem no título. Isso é além do filtro por pontuação, que já roda automaticamente.</div>
                  <textarea id="yt-blocker-titles" class="yt-blocker-textarea"></textarea>

                  <div class="yt-blocker-section-title">Bloquear por nome de canal</div>
                  <div class="yt-blocker-section-desc">Um nome por linha (ex: MrBeast). Pode digitar o nome de exibição OU o @handle — o filtro compara dos dois jeitos agora.</div>
                  <textarea id="yt-blocker-channels" class="yt-blocker-textarea"></textarea>

                  <div class="yt-blocker-settings-buttons">
                      <button id="yt-blocker-settings-cancel" class="yt-blocker-settings-btn yt-blocker-btn-cancel">Cancelar</button>
                      <button id="yt-blocker-settings-save" class="yt-blocker-settings-btn yt-blocker-btn-save">Salvar</button>
                  </div>
              </div>
          </div>
      `;
      document.body.insertAdjacentHTML("beforeend", safeHTML(html));
      modal = document.getElementById("yt-blocker-settings");
      document.getElementById("yt-blocker-settings-cancel").onclick = () => (modal.style.display = "none");
      document.getElementById("yt-blocker-settings-save").onclick = saveSettings;
      document.getElementById("yt-blocker-block-channel-now").onclick = () => {
        blockCurrentChannel();
        document.getElementById("yt-blocker-channels").value = GM_getValue(STORAGE_KEY_CHANNELS, []).join("\n");
      };
      document.getElementById("yt-blocker-block-video-now").onclick = () => {
        blockCurrentVideo();
        document.getElementById("yt-blocker-titles").value = GM_getValue(STORAGE_KEY_TITLES, []).map(stripQuotes).join("\n");
      };
      document.getElementById("yt-blocker-update-github").onclick = () => {
        atualizarDoGitHub(true);
        setTimeout(() => {
          document.getElementById("yt-blocker-titles").value = GM_getValue(STORAGE_KEY_TITLES, []).map(stripQuotes).join("\n");
          document.getElementById("yt-blocker-channels").value = GM_getValue(STORAGE_KEY_CHANNELS, []).join("\n");
        }, 1500);
      };
    }
    const stored = GM_getValue(STORAGE_KEY_TITLES, []);
    document.getElementById("yt-blocker-titles").value = stored.map(stripQuotes).join("\n");
    document.getElementById("yt-blocker-channels").value = GM_getValue(STORAGE_KEY_CHANNELS, []).join("\n");
    modal.style.display = "flex";
  }

  function saveSettings() {
    const lines = document.getElementById("yt-blocker-titles").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const titles = lines.map((line) => line);
    const channels = document.getElementById("yt-blocker-channels").value.split("\n").map((s) => s.trim()).filter(Boolean);

    GM_setValue(STORAGE_KEY_TITLES, titles);
    GM_setValue(STORAGE_KEY_CHANNELS, channels);
    loadTitleKeywords();
    loadChannelNames();
    document.getElementById("yt-blocker-settings").style.display = "none";
    blockContent(true);
  }

  function loadTitleKeywords() {
    const stored = GM_getValue(STORAGE_KEY_TITLES, []);
    processedKeywordSets = stored.map((entry) => {
      const clean = stripQuotes(entry);
      return entry.startsWith('"') && entry.endsWith('"')
        ? [clean.toLowerCase()]
        : clean.toLowerCase().split(" ").filter(Boolean);
    });
  }

  function loadChannelNames() {
    blockedChannelNamesRaw = GM_getValue(STORAGE_KEY_CHANNELS, []);
    blockedChannelNamesPreparados = blockedChannelNamesRaw.map(prepararTermoCanal);
  }

  // ===========================================================
  // ZONA SECRETA (5 toques no canto superior esquerdo abre config)
  // ===========================================================

  const SECRET_ZONE_ID = "yt-blocker-secret-zone";
  const TAPS_REQUIRED = 5;
  const TAP_WINDOW_MS = 2000;
  const DEBUG_MODE = true;
  let tapCount = 0;
  let tapTimer = null;
  let debugLabel = null;

  function showDebug(text) {
    if (!DEBUG_MODE) return;
    if (!debugLabel) {
      debugLabel = document.createElement("div");
      debugLabel.style.cssText = "position:fixed;top:65px;left:8px;z-index:9999999;background:rgba(255,0,0,0.85);color:#fff;font-size:16px;font-weight:bold;padding:6px 12px;border-radius:8px;pointer-events:none;font-family:sans-serif;";
      document.body.appendChild(debugLabel);
    }
    debugLabel.textContent = text;
    debugLabel.style.display = "block";
    clearTimeout(debugLabel._hideTimer);
    debugLabel._hideTimer = setTimeout(() => { if (debugLabel) debugLabel.style.display = "none"; }, 2500);
  }

  function registerSecretTap() {
    tapCount++;
    showDebug("Toque " + tapCount + "/" + TAPS_REQUIRED);
    clearTimeout(tapTimer);
    if (tapCount >= TAPS_REQUIRED) {
      tapCount = 0;
      showDebug("Abrindo configurações...");
      openSettingsModal();
      return;
    }
    tapTimer = setTimeout(() => { tapCount = 0; }, TAP_WINDOW_MS);
  }

  function injectHeaderButton() {
    if (document.getElementById(SECRET_ZONE_ID)) return;
    if (!document.body) return;
    const zone = document.createElement("div");
    zone.id = SECRET_ZONE_ID;
    zone.addEventListener("touchend", function (e) { e.preventDefault(); registerSecretTap(); }, { passive: false });
    zone.addEventListener("click", registerSecretTap);
    document.body.appendChild(zone);
  }

  // ===========================================================
  // EXTRAÇÃO DE DADOS DO VÍDEO/CANAL
  // ===========================================================

  function getCurrentChannelFromWatchPage() {
    const el = document.querySelector(
      "ytd-channel-name a, #channel-name a, yt-formatted-string.ytd-channel-name a, a[href*=\"/@\"], .ytd-video-owner-renderer a, [class*=\"owner\"] a[href*=\"/@\"]"
    );
    return el ? el.textContent.trim() : null;
  }

  function getCurrentVideoTitleFromWatchPage() {
    const el = document.querySelector("yt-formatted-string.ytd-watch-metadata#video-title, h1.ytd-watch-metadata");
    return el ? el.textContent.trim() : null;
  }

  function blockCurrentChannel() {
    let name = lastRightClickedName;
    if (!name && window.location.pathname === "/watch") name = getCurrentChannelFromWatchPage();
    if (!name) { showCustomConfirm("Não consegui identificar o nome do canal."); return; }
    lastRightClickedName = null;
    const current = GM_getValue(STORAGE_KEY_CHANNELS, []);
    if (current.some((c) => normalizarTexto(c) === normalizarTexto(name))) return;
    current.push(name);
    GM_setValue(STORAGE_KEY_CHANNELS, [...new Set(current)]);
    loadChannelNames();
    blockContent(true);
  }

  function blockCurrentVideo() {
    let title = lastRightClickedTitle;
    if (!title && window.location.pathname === "/watch") title = getCurrentVideoTitleFromWatchPage();
    if (!title) { showCustomConfirm("Não consegui identificar o título do vídeo."); return; }
    lastRightClickedTitle = null;
    const current = GM_getValue(STORAGE_KEY_TITLES, []);
    const already = current.some((t) => stripQuotes(t).toLowerCase() === title.toLowerCase());
    if (already) return;
    current.push(title);
    GM_setValue(STORAGE_KEY_TITLES, current);
    loadTitleKeywords();
    blockContent(true);
  }

  function captureRightClick(e) {
    if (e.button !== 2) return;
    lastRightClickedName = null;
    lastRightClickedTitle = null;
    const container = e.target.closest(CARD_SELECTOR);
    if (!container) return;
    const names = container.querySelectorAll('a[href^="/@"]');
    if (names.length) lastRightClickedName = names[0].textContent.trim();
    const title = findVideoTitle(container);
    if (title) lastRightClickedTitle = title;
  }

  function findVideoTitle(container) {
    if (!container) return "";
    const h3 = container.querySelector("h3[title]");
    if (h3 && h3.title) return h3.title.trim();
    const link = container.querySelector("a.ytLockupMetadataViewModelTitle");
    if (link) return link.textContent.trim();
    const titleEl = container.querySelector('a#video-title-link, yt-formatted-string#video-title');
    if (titleEl) return titleEl.textContent.trim();
    const mobileTitle = container.querySelector(
      'h3, .compact-media-item-headline, span.yt-core-attributed-string, .media-item-headline, ' +
      '.shortsLockupViewModelHostMetadataTitle, .shortsLockupViewModelHostOutsideMetadataTitle, ' +
      '[class*="shorts-lockup"] [class*="title"], [class*="ShortsLockup"] [class*="Title"]'
    );
    if (mobileTitle && mobileTitle.textContent.trim()) return mobileTitle.textContent.trim();
    const watchLink = container.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    if (watchLink && watchLink.textContent.trim()) return watchLink.textContent.trim();
    return container.textContent ? container.textContent.trim().slice(0, 200) : "";
  }

  function extractHashtags(container) {
    if (!container) return "";
    const tags = container.querySelectorAll('a[href*="/hashtag/"]');
    return Array.from(tags).map((a) => a.textContent.trim()).join(" ");
  }

  function extractDescricao(container) {
    if (!container) return "";
    const el = container.querySelector('.metadata-snippet-text, yt-formatted-string#description-text, [class*="description-snippet"]');
    return el ? el.textContent.trim() : "";
  }

  // Retorna nomes BRUTOS (sem normalizar) — a normalização acontece
  // dentro de nomeDoCanalBateComBloqueados, num único lugar, pra não
  // haver duas normalizações divergentes (essa era a raiz do bug).
  function extractChannelNames(container) {
    if (!container) return [];
    const results = [];
    const handleLinks = container.querySelectorAll('a[href*="/@"]');
    handleLinks.forEach((a) => {
      const text = a.textContent.trim();
      if (text) results.push(text);
      const match = a.getAttribute("href") && a.getAttribute("href").match(/\/@([^/?&]+)/);
      if (match) { try { results.push(decodeURIComponent(match[1])); } catch (e) { results.push(match[1]); } }
    });
    const channelLinks = container.querySelectorAll('a[href*="/channel/"]');
    channelLinks.forEach((a) => {
      const text = a.textContent.trim();
      if (text) results.push(text);
    });
    if (results.length === 0) {
      const nameEl = container.querySelector('[class*="channel-name"], [class*="ChannelName"], [class*="byline"], [class*="Byline"], .yt-core-attributed-string--link-inherit-color');
      if (nameEl && nameEl.textContent.trim()) results.push(nameEl.textContent.trim());
    }
    return [...new Set(results)];
  }

  function extrairHandleDaURL(pathname) {
    const matchHandle = pathname.match(/^\/@([^/?&]+)/);
    if (matchHandle) { try { return decodeURIComponent(matchHandle[1]); } catch (e) { return matchHandle[1]; } }
    const matchChannel = pathname.match(/^\/channel\/([^/?&]+)/);
    if (matchChannel) return matchChannel[1];
    return null;
  }

  // ===========================================================
  // AVALIAÇÃO HEURÍSTICA DE UM CARD
  // ===========================================================

  function avaliarCardHeuristico(container) {
    const titulo = findVideoTitle(container);
    const canais = extractChannelNames(container);
    const hashtags = extractHashtags(container);
    const descricao = extractDescricao(container);
    return FiltroHeuristico.analisarVideo({ titulo, canal: canais[0] || "", hashtags, descricao });
  }

  // ===========================================================
  // BLOQUEIO DE PÁGINA (canal bloqueado / vídeo pontuado no /watch)
  // ===========================================================

  let paginaJaBloqueada = false;
  let ultimoWatchAvaliado = null;

  function checarBloqueioDePagina() {
    const path = window.location.pathname;

    // Caso 1: está na página do canal (/@handle ou /channel/ID)
    const handleURL = extrairHandleDaURL(path);
    if (handleURL && blockedChannelNamesPreparados.length) {
      const nomesEncontrados = [handleURL];
      const tituloCanal = document.querySelector('h1, [class*="channel-name"], [class*="ChannelName"], #channel-header-container');
      if (tituloCanal && tituloCanal.textContent.trim()) nomesEncontrados.push(tituloCanal.textContent.trim());
      if (nomeDoCanalBateComBloqueados(nomesEncontrados)) {
        if (!paginaJaBloqueada) {
          paginaJaBloqueada = true;
          window.location.replace(window.location.hostname.startsWith("m.") ? "https://m.youtube.com/" : "https://www.youtube.com/");
        }
        return;
      }
    }

    // Caso 2: assistindo um vídeo (/watch) — canal bloqueado manualmente
    // OU pontuação heurística acima do limite
    if (path === "/watch") {
      const canalDoVideo = getCurrentChannelFromWatchPage();
      if (canalDoVideo && nomeDoCanalBateComBloqueados([canalDoVideo])) {
        if (!paginaJaBloqueada) {
          paginaJaBloqueada = true;
          window.location.replace(window.location.hostname.startsWith("m.") ? "https://m.youtube.com/" : "https://www.youtube.com/");
        }
        return;
      }

      const idAtual = window.location.href;
      if (idAtual !== ultimoWatchAvaliado) {
        const titulo = getCurrentVideoTitleFromWatchPage();
        if (titulo) {
          ultimoWatchAvaliado = idAtual;
          const resultado = FiltroHeuristico.analisarVideo({ titulo, canal: canalDoVideo || "" });
          if (MODO_DIAGNOSTICO) console.debug("[Filtro][Watch] pontuacao " + resultado.pontuacao + ":", titulo, "| motivos:", resultado.motivos);
          if (resultado.bloquear) {
            paginaJaBloqueada = true;
            window.location.replace(window.location.hostname.startsWith("m.") ? "https://m.youtube.com/" : "https://www.youtube.com/");
            return;
          }
        }
      }
    }

    paginaJaBloqueada = false;
  }

  // ===========================================================
  // SHORTS
  // ===========================================================

  function tentarPularShortBloqueado() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true }));
    const botaoProximo = document.querySelector(
      '[aria-label*="Next" i], [aria-label*="Próximo" i], [aria-label*="próxima" i], .navigation-button.next-button, #navigation-button-down, [class*="next-button"]'
    );
    if (botaoProximo) { botaoProximo.click(); return; }
    const containerShorts = document.querySelector('#shorts-container, ytd-shorts, ytm-shorts-player-page-renderer, [class*="shorts-player"], [class*="reel-video-in-sequence"]');
    if (containerShorts) containerShorts.scrollBy({ top: window.innerHeight, behavior: "auto" });
    else window.scrollBy({ top: window.innerHeight, behavior: "auto" });
  }

  function encontrarShortAtivo() {
    const candidatos = document.querySelectorAll(
      '[class*="reel-video-in-sequence" i], ytm-shorts-player-page-renderer, [class*="shorts-player-page" i], [class*="reel-item-renderer" i], [class*="shorts-video-renderer" i]'
    );
    let melhor = null;
    let menorDistancia = Infinity;
    candidatos.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.height < 100) return;
      const distancia = Math.abs(rect.top);
      if (distancia < menorDistancia) { menorDistancia = distancia; melhor = el; }
    });
    return melhor || document.body;
  }

  let ultimoShortVerificado = null;

  function checarShortAtual() {
    if (!window.location.pathname.startsWith("/shorts/")) return;
    if (!processedKeywordSets.length && !blockedChannelNamesPreparados.length) {
      // mesmo sem listas manuais, o heurístico continua rodando
    }

    const idAtual = window.location.pathname;
    const escopo = encontrarShortAtivo();

    const tituloEl = escopo.querySelector('h2[class*="title" i], [class*="ShortsTitle"], [class*="shorts-title" i], .ytp-title-link, h2, [class*="video-title" i]');
    const titulo = (tituloEl && tituloEl.textContent ? tituloEl.textContent : "").trim();
    const hashtagsAtuais = extractHashtags(escopo);
    const canais = extractChannelNames(escopo);

    let bloqueado = false;

    // 1) bloqueio manual por palavra-chave no título
    const textoCompletoLower = (titulo + " " + hashtagsAtuais).trim().toLowerCase();
    if (textoCompletoLower) {
      for (const set of processedKeywordSets) {
        if (set.every((k) => textoCompletoLower.includes(k))) { bloqueado = true; break; }
      }
    }

    // 2) bloqueio manual por canal (corrigido)
    if (!bloqueado && canais.length) bloqueado = nomeDoCanalBateComBloqueados(canais);

    // 3) camada heurística por pontuação
    let resultadoHeuristico = null;
    if (!bloqueado) {
      resultadoHeuristico = FiltroHeuristico.analisarVideo({ titulo, canal: canais[0] || "", hashtags: hashtagsAtuais });
      if (resultadoHeuristico.bloquear) bloqueado = true;
    }

    if (MODO_DIAGNOSTICO && (resultadoHeuristico && resultadoHeuristico.pontuacao > 0)) {
      console.debug("[Filtro][Short] pontuacao " + resultadoHeuristico.pontuacao + ":", titulo, "| canais:", canais, "| motivos:", resultadoHeuristico.motivos);
    }

    if (bloqueado && idAtual !== ultimoShortVerificado) {
      ultimoShortVerificado = idAtual;
      tentarPularShortBloqueado();
    }
  }

  // ===========================================================
  // BLOQUEIO DE CARDS NA LISTA/GRADE/BUSCA
  // ===========================================================

  function blockContent(force = false) {
    if (force) {
      document.querySelectorAll(".yt-blocker-remove, .yt-blocker-invisible").forEach((el) => el.classList.remove("yt-blocker-remove", "yt-blocker-invisible"));
    }

    const cards = document.querySelectorAll(CARD_SELECTOR);

    cards.forEach((card) => {
      if (card.classList.contains("yt-blocker-remove") || card.classList.contains("yt-blocker-invisible")) return;

      const title = findVideoTitle(card).toLowerCase();
      const hashtags = extractHashtags(card).toLowerCase();
      const searchText = (title + " " + hashtags).trim();
      let shouldBlock = false;

      // 1) bloqueio manual por palavra-chave
      if (searchText) {
        for (const set of processedKeywordSets) {
          if (set.length === 1 && set[0] === title) { shouldBlock = true; break; }
          if (set.every((k) => searchText.includes(k))) { shouldBlock = true; break; }
        }
      }

      // 2) bloqueio manual por canal (corrigido — compara nome de exibição E handle)
      if (!shouldBlock) {
        const chs = extractChannelNames(card);
        if (chs.length && nomeDoCanalBateComBloqueados(chs)) {
          shouldBlock = true;
        } else if (!chs.length && blockedChannelNamesPreparados.length) {
          const textoCard = (card.textContent || "").toLowerCase();
          shouldBlock = blockedChannelNamesPreparados.some((b) => b.normal && textoCard.includes(b.normal));
        }
      }

      // 3) camada heurística por pontuação
      let resultadoHeuristico = null;
      if (!shouldBlock) {
        resultadoHeuristico = avaliarCardHeuristico(card);
        if (resultadoHeuristico.bloquear) shouldBlock = true;
      }

      if (MODO_DIAGNOSTICO && resultadoHeuristico && resultadoHeuristico.bloquear) {
        console.debug("[Filtro][Card] pontuacao " + resultadoHeuristico.pontuacao + ":", findVideoTitle(card), "| motivos:", resultadoHeuristico.motivos);
      }

      if (shouldBlock) {
        if (location.pathname === "/") {
          card.removeAttribute("is-in-first-column");
          card.classList.remove("hide-grid-cell");
        }
        card.classList.add(hideOnlyMode ? "yt-blocker-invisible" : "yt-blocker-remove");
      }
    });
  }

  function showCustomConfirm(message, callback) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;";
    overlay.innerHTML = safeHTML(`
        <div style="background:#282828;color:#fff;border-radius:12px;padding:24px;max-width:460px;text-align:center;">
            <p style="font-size:16px;margin:0 0 20px;white-space:pre-wrap;">${message}</p>
            <div style="display:flex;justify-content:center;gap:12px;">
                ${callback ? '<button id="cancel" style="padding:10px 24px;border:none;border-radius:20px;background:#383838;color:#fff;cursor:pointer;">Cancelar</button>' : ""}
                <button id="ok" style="padding:10px 24px;border:none;border-radius:20px;background:#3ea6ff;color:#000;font-weight:600;cursor:pointer;">OK</button>
            </div>
        </div>
    `);
    document.body.appendChild(overlay);
    const cancelBtn = overlay.querySelector("#cancel");
    if (cancelBtn) cancelBtn.onclick = () => overlay.remove();
    overlay.querySelector("#ok").onclick = () => { overlay.remove(); if (callback) callback(); };
  }

  // ===========================================================
  // ATUALIZAÇÃO REMOTA VIA GITHUB
  // ===========================================================

  function buscarConteudoGitHub(url) {
    if (!url || url.startsWith("COLE_AQUI")) return Promise.reject(new Error("URL nao configurada"));
    // "cache: no-store" evita pegar versão antiga em cache
    const urlSemCache = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
    return fetch(urlSemCache, { cache: "no-store" })
      .then((resp) => {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.text();
      })
      .then((texto) =>
        (texto || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      );
  }

  // Junta o que já existia localmente (inclusive o que foi bloqueado
  // direto no celular, pelo menu de "Bloquear este canal/vídeo") com
  // o que veio do GitHub, sem duplicar. Assim editar o GitHub nunca
  // apaga um bloqueio que você fez direto no aparelho.
  function mesclarListas(local, remoto) {
    const vistos = new Set(local.map((x) => x.toLowerCase()));
    const resultado = [...local];
    for (const item of remoto) {
      if (!vistos.has(item.toLowerCase())) {
        vistos.add(item.toLowerCase());
        resultado.push(item);
      }
    }
    return resultado;
  }

  async function atualizarDoGitHub(manual) {
    if (!GITHUB_ATIVO) {
      if (manual) showCustomConfirm("Atualização via GitHub ainda não configurada. Preencha GITHUB_URL_TITULOS e GITHUB_URL_CANAIS no início do script.");
      return;
    }
    try {
      const [titulosRemoto, canaisRemoto] = await Promise.all([
        buscarConteudoGitHub(GITHUB_URL_TITULOS),
        buscarConteudoGitHub(GITHUB_URL_CANAIS)
      ]);

      const titulosLocal = GM_getValue(STORAGE_KEY_TITLES, []);
      const canaisLocal = GM_getValue(STORAGE_KEY_CHANNELS, []);

      GM_setValue(STORAGE_KEY_TITLES, mesclarListas(titulosLocal, titulosRemoto));
      GM_setValue(STORAGE_KEY_CHANNELS, mesclarListas(canaisLocal, canaisRemoto));
      GM_setValue(STORAGE_KEY_ULTIMA_ATT_GITHUB, new Date().toISOString());

      loadTitleKeywords();
      loadChannelNames();
      blockContent(true);

      if (manual) showCustomConfirm("Filtros atualizados do GitHub com sucesso.");
      if (MODO_DIAGNOSTICO) console.debug("[Filtro][GitHub] atualizado:", { titulosRemoto, canaisRemoto });
    } catch (e) {
      if (manual) showCustomConfirm("Não consegui atualizar do GitHub: " + e.message);
      if (MODO_DIAGNOSTICO) console.debug("[Filtro][GitHub] erro:", e.message);
    }
  }

  // ===========================================================
  // INIT
  // ===========================================================

  loadTitleKeywords();
  loadChannelNames();
  hideOnlyMode = GM_getValue(STORAGE_KEY_HIDE_ONLY, false);

  // GM_registerMenuCommand não existe no Webview Kiosk — as ações de
  // "bloquear canal/vídeo atual" e "atualizar do GitHub" agora são
  // botões dentro do próprio modal de configurações (ver openSettingsModal)

  if (GITHUB_ATIVO) {
    setTimeout(() => atualizarDoGitHub(false), 3000);
    setInterval(() => atualizarDoGitHub(false), GITHUB_ATUALIZAR_A_CADA_MS);
  }

  function bloquearBotoesInteracao(e) {
    const alvo = e.target.closest(
      '[aria-label*="Subscribe" i], [aria-label*="Inscrever" i], [aria-label*="Increver" i], button.subscribe-button, ytd-subscribe-button-renderer, ytm-subscribe-button-renderer, [class*="subscribe-button" i], [aria-label*="like this video" i], [aria-label*="Gostei" i], [aria-label*="gostei deste" i], #like-button, .like-button-renderer, [class*="like-button" i], [class*="dislike-button" i], [aria-label*="dislike" i], [aria-label*="não gostei" i], [aria-label*="nao gostei" i]'
    );
    if (alvo) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }
  }

  document.addEventListener("click", bloquearBotoesInteracao, true);
  document.addEventListener("touchend", bloquearBotoesInteracao, true);
  document.addEventListener("mousedown", captureRightClick, true);

  function run() {
    injectHeaderButton();
    checarBloqueioDePagina();
    checarShortAtual();
    blockContent();
  }
  setInterval(run, 600);
})();
