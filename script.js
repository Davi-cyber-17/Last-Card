'use strict';
/* ===== Configuração do modo online =====
   Os jogadores se conectam direto entre si (WebRTC via PeerJS), sem servidor próprio.
   Redes muito restritivas (alguns 4G/5G e redes corporativas) podem exigir um servidor TURN:
   se for o caso, descomente a linha do TURN e preencha seus dados. */
const PEER_OPTS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
      // , { urls: 'turn:SEU_SERVIDOR:3478', username: 'USUARIO', credential: 'SENHA' }
    ]
  }
};
const ROOM = 'lastcard-';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const CN = { r: 'vermelho', y: 'amarelo', g: 'verde', b: 'azul' };
const SYM = { skip: '⊘', rev: '⇄', wild: '✦' };
const NAME = { skip: 'Pular', rev: 'Inverter', wild: 'Coringa' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const seatColor = i => `var(--${'rygb'[i % 4]})`;

let mode = null, G = null, V = null, viewer = 0, localHumans = 1, botT = null;
let peer = null, net = { players: [], conn: null, code: '', name: '' }, tries = 0;

function show(id) { $$('.screen').forEach(s => s.classList.toggle('on', s.id === id)); }
function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), 2600); }

/* ============ MOTOR DO JOGO (roda no anfitrião ou no modo local) ============ */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }
function mkDeck() {
  const d = [];
  for (const c of 'rygb') {
    d.push({ c, v: '0' });
    for (let n = 1; n <= 9; n++) d.push({ c, v: '' + n }, { c, v: '' + n });
    for (const v of ['skip', 'rev', '+2']) d.push({ c, v }, { c, v });
  }
  for (let i = 0; i < 4; i++) d.push({ c: 'w', v: 'wild' }, { c: 'w', v: '+4' });
  return shuffle(d);
}
const topCard = () => G.discard[G.discard.length - 1];
const can = c => c.c === 'w' || c.c === G.color || c.v === topCard().v;
const label = (c, col) => c.c === 'w' ? `${c.v === '+4' ? '+4' : 'Coringa'} (${CN[col]})` : `${NAME[c.v] || c.v} ${CN[c.c]}`;

function newGame(list) {
  G = { players: list.map(p => ({ name: p.name, ai: !!p.ai, hand: [] })), deck: mkDeck(), discard: [], turn: 0, dir: 1, color: 'r', drawn: false, winner: null, msg: 'Vamos jogar!' };
  G.players.forEach(p => { for (let i = 0; i < 7; i++) p.hand.push(G.deck.pop()); });
  let c;
  do { c = G.deck.pop(); if (c.c === 'w' || isNaN(c.v)) { G.deck.unshift(c); c = null; } } while (!c);
  G.discard.push(c); G.color = c.c;
}
function draw1() {
  if (!G.deck.length) { const t = G.discard.pop(); G.deck = shuffle(G.discard); G.discard = [t]; }
  return G.deck.pop() || null;
}
const nxt = () => { const L = G.players.length; return ((G.turn + G.dir) % L + L) % L; };
function adv(n) { const L = G.players.length; G.turn = ((G.turn + G.dir * n) % L + L) % L; G.drawn = false; }
function give(pi, n) { for (let i = 0; i < n; i++) { const c = draw1(); if (c) G.players[pi].hand.push(c); } }

function play(pi, idx, col) {
  if (G.winner != null || pi !== G.turn) return false;
  const p = G.players[pi], c = p.hand[idx];
  if (!c || !can(c) || (G.drawn && idx !== p.hand.length - 1)) return false;
  if (c.c === 'w' && !CN[col]) return false;
  p.hand.splice(idx, 1); G.discard.push(c); G.color = c.c === 'w' ? col : c.c;
  let m = `${p.name} jogou ${label(c, col)}`;
  if (!p.hand.length) { G.winner = pi; G.msg = `${p.name} descartou a última carta!`; return true; }
  if (c.v === 'rev') { G.dir *= -1; adv(G.players.length === 2 ? 2 : 1); }
  else if (c.v === 'skip') { m += ` · ${G.players[nxt()].name} perde a vez`; adv(2); }
  else if (c.v === '+2' || c.v === '+4') { const t = nxt(), n = c.v === '+2' ? 2 : 4; give(t, n); m += ` · ${G.players[t].name} compra ${n}`; adv(2); }
  else adv(1);
  if (p.hand.length === 1) m += ' · ÚLTIMA CARTA!';
  G.msg = m; return true;
}
function drawAct(pi) {
  if (G.winner != null || pi !== G.turn || G.drawn) return false;
  const p = G.players[pi], c = draw1();
  if (!c) { G.msg = 'Não há mais cartas no monte'; adv(1); return true; }
  p.hand.push(c);
  if (can(c)) { G.drawn = true; G.msg = `${p.name} comprou uma carta`; }
  else { G.msg = `${p.name} comprou e passou a vez`; adv(1); }
  return true;
}
function passAct(pi) {
  if (pi !== G.turn || !G.drawn) return false;
  G.msg = `${G.players[pi].name} passou a vez`; adv(1); return true;
}
function botMove() {
  const pi = G.turn, p = G.players[pi];
  const pick = () => {
    const ok = p.hand.map((_, i) => i).filter(i => can(p.hand[i]) && (!G.drawn || i === p.hand.length - 1));
    const n = ok.filter(i => p.hand[i].c !== 'w');
    return n.length ? n[Math.random() * n.length | 0] : ok[0];
  };
  let i = pick();
  if (i === undefined) { drawAct(pi); if (G.turn !== pi || G.winner != null) return; i = pick(); if (i === undefined) { passAct(pi); return; } }
  const cnt = { r: 0, y: 0, g: 0, b: 0 };
  p.hand.forEach(c => { if (c.c !== 'w') cnt[c.c]++; });
  play(pi, i, Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0]);
}
function view(pi, hide) {
  const hand = hide ? [] : G.players[pi].hand;
  return {
    me: pi, hide: !!hide, hand, top: topCard(), color: G.color, turn: G.turn, dir: G.dir, deck: G.deck.length, drawn: G.drawn, winner: G.winner, msg: G.msg,
    players: G.players.map(q => ({ name: q.name, n: q.hand.length, ai: q.ai })),
    ok: hand.map((c, i) => G.turn === pi && G.winner == null && can(c) && (!G.drawn || i === hand.length - 1))
  };
}

/* ============ CONTROLE (local / anfitrião / cliente) ============ */
function apply(pi, a) {
  if (a.t === 'play') play(pi, a.idx, a.color); else if (a.t === 'draw') drawAct(pi); else if (a.t === 'pass') passAct(pi);
  refresh();
}
function act(a) {
  if (mode === 'client') net.conn && net.conn.open && net.conn.send(a);
  else apply(mode === 'host' ? 0 : viewer, a);
}
function refresh() {
  if (mode === 'host') {
    net.players.forEach((p, i) => { if (i && p.conn && p.conn.open) p.conn.send({ t: 'state', v: view(i) }); });
    render(view(0));
  } else localRefresh();
  clearTimeout(botT);
  if (G.winner == null && G.players[G.turn].ai) botT = setTimeout(() => { botMove(); refresh(); }, 1000);
}
function localRefresh() {
  const cur = G.players[G.turn];
  $('#curtain').hidden = true;
  if (G.winner != null) return render(view(Math.max(viewer, 0), localHumans > 1));
  if (cur.ai) return render(view(localHumans > 1 ? G.turn : viewer, localHumans > 1));
  if (localHumans > 1 && G.turn !== viewer) {
    render(view(G.turn, true));
    $('#curtainName').textContent = cur.name; $('#curtain').hidden = false; return;
  }
  viewer = G.turn; render(view(viewer));
}
$('#curtainGo').onclick = () => { viewer = G.turn; localRefresh(); };

/* ============ RENDER ============ */
const inner = c => { const s = SYM[c.v] || c.v; return `<i class="k tl">${s}</i><b class="v">${s}</b><i class="k br">${s}</i>`; };
const cardCls = c => c.c === 'w' ? 'c-w' : 'c-' + c.c;
const backCard = '<div class="card back"><b class="v">LC</b></div>';

function render(v) {
  V = v; show('game');
  const L = v.players.length, myTurn = v.turn === v.me && !v.hide && v.winner == null;
  $('#seats').innerHTML = Array.from({ length: L - 1 }, (_, k) => {
    const i = (v.me + k + 1) % L, p = v.players[i], a = Math.PI / 2 + (k + 1) * 2 * Math.PI / L;
    const x = 50 + 42 * Math.cos(a), y = 50 + 37 * Math.sin(a);
    return `<div class="seat ${i === v.turn ? 'turn' : ''}" style="left:${x}%;top:${y}%;--sc:${seatColor(i)}">
      <div class="fan">${'<div class="card back mini"></div>'.repeat(Math.min(p.n, 10))}</div>
      <div class="tag">${esc(p.name)}${p.ai ? ' 🤖' : ''} <small>${p.n} ${p.n === 1 ? 'carta' : 'cartas'}</small></div></div>`;
  }).join('');
  const ring = $('#ring');
  ['r', 'b', 'y', 'g'].forEach(c => ring.style.setProperty('--a' + c, c === v.color ? 1 : .3));
  $('#dirRing').classList.toggle('rev', v.dir < 0);
  const dp = $('#drawPile'); dp.innerHTML = backCard + `<span class="cnt">Monte · ${v.deck}</span>`;
  dp.classList.toggle('ok', myTurn && !v.drawn);
  $('#discard').innerHTML = `<div class="card ${cardCls(v.top)}">${inner(v.top)}</div>`;
  $('#discard').style.setProperty('--glow', `var(--${v.color})`);
  $('#msg').textContent = v.msg;
  const me = v.players[v.me];
  const mt = $('#meTag'); mt.textContent = v.hide ? `Vez de ${v.players[v.turn].name}` : myTurn ? `${me.name} · sua vez!` : `${me.name} · vez de ${v.players[v.turn].name}`;
  mt.classList.toggle('turn', myTurn); mt.style.setProperty('--sc', seatColor(v.me));
  $('#pass').hidden = !(myTurn && v.drawn);
  $('#roomTag').textContent = mode === 'local' ? 'LOCAL' : 'SALA ' + net.code;
  const hand = $('#hand');
  hand.innerHTML = v.hand.map((c, i) => `<div class="card ${cardCls(c)} ${myTurn ? (v.ok[i] ? 'ok' : 'no') : ''}" data-i="${i}" ${v.ok[i] ? 'tabindex="0" role="button"' : ''}>${inner(c)}</div>`).join('');
  const cs = hand.children, n = cs.length;
  if (n > 1) {
    const cw = cs[0].offsetWidth, avail = hand.clientWidth - 8;
    const m = n * cw + (n - 1) * 6 <= avail ? 6 : -(n * cw - avail) / (n - 1);
    for (let i = 1; i < n; i++) cs[i].style.marginLeft = m + 'px';
  }
  $('#win').hidden = v.winner == null;
  if (v.winner != null) {
    $('#winText').textContent = v.winner === v.me && !v.hide ? 'Você venceu! 🎉' : `${v.players[v.winner].name} venceu!`;
    $('#again').hidden = mode === 'client'; $('#winWait').hidden = mode !== 'client';
  }
}
window.addEventListener('resize', () => V && $('#game').classList.contains('on') && render(V));

/* ============ EVENTOS DA MESA ============ */
const touch = matchMedia('(hover:none)').matches;
function pickColor(cb) {
  $('#modal').hidden = false;
  $$('#modal .cb').forEach(b => b.onclick = () => { $('#modal').hidden = true; cb(b.dataset.c); });
}
function clickCard(e) {
  const el = e.target.closest('.card.ok'); if (!el) return;
  if (touch && !el.classList.contains('sel')) { $$('#hand .sel').forEach(x => x.classList.remove('sel')); el.classList.add('sel'); return; } // toque 1: destaca, toque 2: joga
  const i = +el.dataset.i, c = V.hand[i];
  c.c === 'w' ? pickColor(col => act({ t: 'play', idx: i, color: col })) : act({ t: 'play', idx: i });
}
$('#hand').onclick = clickCard;
$('#hand').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickCard(e); } };
$('#drawPile').onclick = () => { if (V && $('#drawPile').classList.contains('ok')) act({ t: 'draw' }); };
$('#pass').onclick = () => act({ t: 'pass' });
$('#exit').onclick = () => { if (confirm('Sair da partida?')) location.reload(); };
$('#toMenu').onclick = () => location.reload();
$('#again').onclick = () => {
  newGame(G.players.map(p => ({ name: p.name.replace(' (saiu)', ''), ai: p.ai })));
  if (mode === 'local' && localHumans > 1) viewer = -1;
  refresh();
};

/* ============ MENU E MODO LOCAL ============ */
$$('[data-go]').forEach(b => b.onclick = () => show(b.dataset.go));
$('#btnOnline').onclick = () => { $('#oName').value = $('#oName').value || localStorage.getItem('lc-name') || ''; show('online'); };
$('#btnLocal').onclick = () => { buildRows(); show('local'); };

let slots = Array.from({ length: 8 }, () => ({ name: '', ai: false })), nPl = 4;
function buildRows() {
  $('#nPl').textContent = nPl;
  $('#rows').innerHTML = slots.slice(0, nPl).map((s, i) => `<div class="r"><input type="text" class="nm" maxlength="14" placeholder="Jogador ${i + 1}" value="${esc(s.name)}" style="--sc:${seatColor(i)}" data-i="${i}"><label><input type="checkbox" class="ai" data-i="${i}" ${s.ai ? 'checked' : ''}>Bot</label></div>`).join('');
}
function saveRows() { $$('#rows .nm').forEach(e => slots[+e.dataset.i].name = e.value); $$('#rows .ai').forEach(e => slots[+e.dataset.i].ai = e.checked); }
$('#minus').onclick = () => { saveRows(); nPl = Math.max(2, nPl - 1); buildRows(); };
$('#plus').onclick = () => { saveRows(); nPl = Math.min(8, nPl + 1); buildRows(); };
$('#startLocal').onclick = () => {
  saveRows();
  const list = slots.slice(0, nPl).map((s, i) => ({ name: s.name.trim() || (s.ai ? `Bot ${i + 1}` : `Jogador ${i + 1}`), ai: s.ai }));
  localHumans = list.filter(p => !p.ai).length;
  if (!localHumans) return toast('Deixe pelo menos um jogador humano');
  mode = 'local'; newGame(list);
  viewer = localHumans > 1 ? -1 : list.findIndex(p => !p.ai);
  refresh();
};

/* ============ MODO ONLINE (salas por código, funciona entre qualquer dispositivo) ============ */
const genCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join('');
const readName = () => { const n = $('#oName').value.trim() || 'Jogador'; localStorage.setItem('lc-name', n); return n; };
const qs = new URLSearchParams(location.search).get('sala');
if (qs) { $('#oCode').value = qs.toUpperCase().slice(0, 4); $('#oName').value = localStorage.getItem('lc-name') || ''; show('online'); }

async function keepAwake() { try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) { } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (mode === 'host' || mode === 'client')) keepAwake(); });

function netFail(msg) { toast(msg); if (peer) peer.destroy(); peer = null; mode = null; show('online'); }
const noLib = () => typeof Peer === 'undefined' && (toast('Não foi possível carregar a biblioteca online. Verifique a internet.'), true);

$('#create').onclick = () => {
  if (noLib()) return;
  mode = 'host'; G = null; net.players = [{ name: readName(), ai: false, conn: null }]; keepAwake();
  const open = () => {
    net.code = genCode(); peer = new Peer(ROOM + net.code, PEER_OPTS);
    peer.on('open', () => { lobbyUI(); show('lobby'); });
    peer.on('connection', c => { c.on('data', d => hostData(c, d)); c.on('close', () => drop(c)); });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { } });
    peer.on('error', e => { if (e.type === 'unavailable-id') { peer.destroy(); open(); } else if (e.type !== 'peer-unavailable') netFail('Erro de conexão: ' + e.type); });
  };
  open();
};
function uniq(n) { const b = n.trim() || 'Jogador'; let x = b, k = 2; while (net.players.some(p => p.name === x)) x = b + ' ' + k++; return x; }
function hostData(c, d) {
  if (d.t === 'join') {
    const nm = String(d.name).slice(0, 14);
    if (G) { // partida em andamento: só quem saiu pode voltar para a própria vaga
      const i = net.players.findIndex(p => p.left && p.name === nm);
      if (i < 0) return c.send({ t: 'err', msg: 'A partida já começou.' });
      Object.assign(net.players[i], { conn: c, ai: false, left: false }); G.players[i].ai = false; G.players[i].name = nm;
      return refresh();
    }
    if (net.players.length >= 8) return c.send({ t: 'err', msg: 'Sala cheia (máximo de 8).' });
    net.players.push({ name: uniq(nm), ai: false, conn: c }); lobbyUI();
  } else {
    const i = net.players.findIndex(p => p.conn === c);
    if (i > 0 && G) apply(i, d);
  }
}
function drop(c) {
  const i = net.players.findIndex(p => p.conn === c); if (i < 1) return;
  if (!G) { net.players.splice(i, 1); lobbyUI(); }
  else { net.players[i].ai = true; net.players[i].left = true; G.players[i].ai = true; G.players[i].name = net.players[i].name + ' (saiu)'; refresh(); }
}
function lobbyUI() {
  const names = net.players.map(p => p.name + (p.ai ? ' 🤖' : ''));
  net.players.forEach((p, i) => { if (i && p.conn && p.conn.open) p.conn.send({ t: 'lobby', names, you: i, code: net.code }); });
  drawLobby(names, 0);
}
function drawLobby(names, you) {
  $('#roomCode').textContent = net.code;
  $('#plist').innerHTML = names.map((n, i) => `<li style="--sc:${seatColor(i)}">${esc(n)}${i === 0 ? ' · anfitrião' : ''}${i === you ? ' (você)' : ''}</li>`).join('');
  const host = mode === 'host';
  $('#addBot').hidden = $('#startOnline').hidden = !host;
  $('#startOnline').disabled = names.length < 2;
  $('#lobbyInfo').textContent = host ? (names.length < 2 ? 'Compartilhe o código para chamar jogadores (mínimo 2).' : `${names.length} de 8 jogadores`) : 'Aguardando o anfitrião começar a partida...';
}
$('#addBot').onclick = () => {
  if (net.players.length >= 8) return toast('Sala cheia');
  net.players.push({ name: uniq('Bot ' + net.players.length), ai: true, conn: null }); lobbyUI();
};
$('#startOnline').onclick = () => {
  if (net.players.length < 2) return;
  newGame(net.players.map(p => ({ name: p.name, ai: p.ai }))); refresh();
};
$('#copy').onclick = () => {
  const link = location.origin + location.pathname + '?sala=' + net.code;
  (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Link copiado!'), () => toast('Código da sala: ' + net.code));
};
$('#leave').onclick = () => location.reload();

function joinRoom(code, name) {
  if (noLib()) return;
  mode = 'client'; net.code = code; net.name = name; keepAwake();
  if (peer) peer.destroy();
  peer = new Peer(PEER_OPTS);
  const timer = setTimeout(() => retry('Não foi possível entrar na sala'), 12000);
  peer.on('error', e => { clearTimeout(timer); e.type === 'peer-unavailable' ? netFail('Sala não encontrada') : retry('Erro de conexão: ' + e.type); });
  peer.on('open', () => {
    const c = net.conn = peer.connect(ROOM + code, { reliable: true });
    c.on('open', () => { clearTimeout(timer); c.send({ t: 'join', name }); });
    c.on('data', d => {
      tries = 0;
      if (d.t === 'lobby') { net.code = d.code; drawLobby(d.names, d.you); show('lobby'); }
      else if (d.t === 'state') render(d.v);
      else if (d.t === 'err') netFail(d.msg);
    });
    c.on('close', () => { clearTimeout(timer); if (mode === 'client') retry('Conexão perdida'); });
  });
}
function retry(msg) { // tenta reconectar automaticamente (ex.: o celular saiu do app por alguns segundos)
  if (mode !== 'client') return;
  if (tries++ < 4) { toast(msg + ' · reconectando...'); setTimeout(() => joinRoom(net.code, net.name), 2000); }
  else { toast(msg); setTimeout(() => location.reload(), 1800); }
}
$('#join').onclick = () => {
  const code = $('#oCode').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Digite o código de 4 letras da sala');
  tries = 0; toast('Conectando...'); joinRoom(code, readName());
};
