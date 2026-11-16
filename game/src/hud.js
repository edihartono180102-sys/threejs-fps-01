// The DOM HUD: crosshair, hit marker, health, ammo, money, round timer and score,
// team pips, kill feed, bomb banner, buy menu and the overlay panels. It never touches
// the simulation; the simulation pushes numbers in and reads callbacks out. Every
// update is cached, so a value that did not change costs no DOM write.
// New since the first build: the bomb banner carries a fuse progress bar, the topbar
// carries a round-history strip (W/L per round), and a toast line announces match
// events (a plant, a save round, a mute toggle) without touching the kill feed.
const BUY_ITEMS = [
  { key: '1', id: 'rifle', name: 'VK-47 rifle', price: 2700, note: '34 dmg · auto' },
  { key: '2', id: 'smg', name: 'Hornet-9 SMG', price: 1500, note: '22 dmg · fast' },
  { key: '3', id: 'shotgun', name: 'Breach-12 shotgun', price: 1200, note: '8 pellets · close' },
  { key: '4', id: 'grenade', name: 'Spark-9 grenade', price: 300, note: 'blast radius 6 m' },
  { key: '5', id: 'armor', name: 'Plate armor', price: 650, note: 'absorbs half damage' },
];

export function createHud(callbacks) {
  const $ = (id) => document.getElementById(id);
  const el = {
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    health: $('health-value'),
    healthBar: $('health-bar'),
    armor: $('armor-value'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    ammo: $('ammo'),
    weapon: $('weapon-name'),
    money: $('money-value'),
    timer: $('timer-value'),
    round: $('round-value'),
    history: $('round-history'),
    emberPips: $('ember-pips'),
    ashPips: $('ash-pips'),
    bomb: $('bomb-banner'),
    bombText: $('bomb-text'),
    bombProgress: $('bomb-progress'),
    feed: $('killfeed'),
    toast: $('toast'),
    vignette: $('damage-vignette'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayCopy: $('overlay-copy'),
    play: $('play'),
    buy: $('buy-menu'),
    buyList: $('buy-list'),
    buyMoney: $('buy-money'),
    mute: $('mute-btn'),
  };
  let hitTimer = 0;
  let toastTimer = 0;
  let last = {};
  let feedCount = 0;

  function setText(node, key, value) {
    if (!node) return;
    if (last[key] !== value) {
      last[key] = value;
      node.textContent = value;
    }
  }

  function buildBuy() {
    el.buyList.innerHTML = '';
    for (const item of BUY_ITEMS) {
      const row = document.createElement('div');
      row.className = 'buy-row';
      row.dataset.id = item.id;
      row.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-name">${item.name}</span><span class="buy-note">${item.note}</span><span class="buy-price">$${item.price}</span>`;
      row.addEventListener('click', () => callbacks.onBuy(item.id));
      el.buyList.appendChild(row);
    }
  }
  buildBuy();
  if (el.mute && callbacks.onMute) {
    el.mute.addEventListener('click', () => callbacks.onMute());
  }

  return {
    setHealth(health, armor) {
      setText(el.health, 'health', String(Math.max(0, Math.ceil(health))));
      setText(el.armor, 'armor', armor > 0 ? `+${Math.ceil(armor)}` : '');
      const width = `${Math.max(0, Math.min(100, health))}%`;
      if (last.healthWidth !== width) {
        last.healthWidth = width;
        el.healthBar.style.width = width;
      }
      el.healthBar.style.background = health <= 30 ? '#ff2a1a' : '#ff7a1a';
    },
    setAmmo(mag, reserve, weaponName) {
      setText(el.ammoMag, 'mag', String(mag));
      setText(el.ammoReserve, 'reserve', reserve === Infinity ? '/ ∞' : `/ ${reserve}`);
      setText(el.weapon, 'weapon', weaponName);
      el.ammo.classList.toggle('empty', mag === 0);
      // Low magazine: pulse the ammo readout so a dry gun is not a surprise.
      el.ammo.classList.toggle('low', mag > 0 && mag <= 4);
    },
    setMoney(money) {
      setText(el.money, 'money', `$${money}`);
      setText(el.buyMoney, 'buyMoney', `$${money}`);
    },
    setTimer(seconds) {
      const total = Math.max(0, Math.ceil(seconds));
      const text = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      setText(el.timer, 'timer', text);
      el.timer.classList.toggle('low', total <= 10);
    },
    setRound(ember, ash, round) {
      setText(el.round, 'round', `ROUND ${round} · EMBER ${ember} — ${ash} ASH`);
    },
    // Round history: one dot per finished round, orange for an Ember win, blue
    // for Ash. Cached on the joined string, so a repeated call costs nothing.
    setHistory(results) {
      if (!el.history) return;
      const text = results.map((r) => (r === 'ember' ? '●' : '○')).join('');
      if (last.history !== text) {
        last.history = text;
        el.history.textContent = text;
        el.history.className = 'history';
      }
    },
    setPips(emberAlive, emberTotal, ashAlive, ashTotal) {
      const e = '●'.repeat(emberAlive) + '○'.repeat(Math.max(0, emberTotal - emberAlive));
      const a = '●'.repeat(ashAlive) + '○'.repeat(Math.max(0, ashTotal - ashAlive));
      setText(el.emberPips, 'emberPips', e);
      setText(el.ashPips, 'ashPips', a);
    },
    // text is the banner line; progress (0..1) fills the fuse bar when given.
    // A null progress leaves the bar as it was; an empty text hides the banner.
    // The text goes on #bomb-text, never on the banner itself: setting
    // textContent on the banner would wipe its #bomb-progress child.
    setBomb(text, progress = null) {
      setText(el.bombText || el.bomb, 'bomb', text || '');
      el.bomb.hidden = !text;
      if (progress !== null && el.bombProgress) {
        const width = `${Math.max(0, Math.min(100, progress * 100))}%`;
        if (last.bombWidth !== width) {
          last.bombWidth = width;
          el.bombProgress.style.width = width;
        }
      }
    },
    setCrosshair(spreadPx) {
      const gap = Math.round(4 + spreadPx * 900);
      if (last.gap !== gap) {
        last.gap = gap;
        el.crosshair.style.setProperty('--gap', `${gap}px`);
      }
    },
    hitMarker(killed, holdMs = 90) {
      el.hitmarker.classList.add('on');
      el.hitmarker.style.transform = killed ? 'translate(-50%, -50%) rotate(45deg) scale(1.3)' : '';
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => {
        el.hitmarker.classList.remove('on');
        el.hitmarker.style.transform = '';
      }, holdMs);
    },
    damageFlash() {
      el.vignette.classList.add('on');
      setTimeout(() => el.vignette.classList.remove('on'), 180);
    },
    killfeed(text) {
      feedCount += 1;
      const row = document.createElement('div');
      row.className = 'feed-row';
      row.textContent = text;
      el.feed.prepend(row);
      while (el.feed.children.length > 5) el.feed.removeChild(el.feed.lastChild);
      setTimeout(() => row.remove(), 6000);
    },
    // One-line announcement under the topbar: a plant, a save, a mute toggle.
    // Replaces the previous toast instead of stacking, and fades after 3 s.
    toast(text) {
      if (!el.toast) return;
      el.toast.textContent = text;
      el.toast.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.toast.classList.remove('on'), 3000);
    },
    showOverlay(title, copy, action) {
      el.overlayTitle.textContent = title;
      el.overlayCopy.textContent = copy;
      el.play.textContent = action;
      el.overlay.hidden = false;
      el.play.focus();
    },
    hideOverlay() {
      el.overlay.hidden = true;
    },
    onPlay(handler) {
      el.play.addEventListener('click', handler);
    },
    showBuy(money, owned, grenades, armor) {
      this.setMoney(money);
      this.refreshBuy(money, owned, grenades, armor);
      el.buy.hidden = false;
    },
    // Grey out what the player cannot buy right now (unaffordable, already
    // owned, grenades full, armor full). Cached on one signature string so the
    // per-step call during the buy phase costs no DOM write when nothing changed.
    refreshBuy(money, owned, grenades, armor) {
      const signature = [
        money,
        owned && owned.rifle ? 1 : 0,
        owned && owned.smg ? 1 : 0,
        owned && owned.shotgun ? 1 : 0,
        grenades,
        armor,
      ].join('|');
      if (last.buySig === signature) return;
      last.buySig = signature;
      const prices = { rifle: 2700, smg: 1500, shotgun: 1200, grenade: 300, armor: 650 };
      for (const row of el.buyList.children) {
        const id = row.dataset.id;
        const isOwned = owned && owned[id] === true;
        const isFull = (id === 'grenade' && grenades >= 2) || (id === 'armor' && armor >= 50);
        row.classList.toggle('owned', isOwned);
        row.classList.toggle('cant', !isOwned && (money < prices[id] || isFull));
      }
    },
    hideBuy() {
      el.buy.hidden = true;
    },
    markBought(id, canAfford) {
      for (const row of el.buyList.children) {
        row.classList.toggle('cant', row.dataset.id === id && !canAfford);
      }
    },
  };
}
