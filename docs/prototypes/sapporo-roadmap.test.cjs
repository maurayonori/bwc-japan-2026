// 実行: node docs/prototypes/sapporo-roadmap.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const html = fs.readFileSync(path.join(__dirname, 'sapporo-roadmap.html'), 'utf8');
const model = html.match(/<script id="model">([\s\S]*?)<\/script>/)[1];
const data = JSON.parse(html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
const c = vm.createContext({});
vm.runInContext(model, c);
const d = c.parseDay;
const iso = (n) => (n == null ? null : c.iso(n));
const plan = (birth, today, extra = {}) => c.planAll(data, { birth, ...extra }, d(today));
const item = (pl, id) => {
  const p = pl.items.find((x) => x.id === id);
  assert.ok(p, `項目が無い: ${id}`);
  return p;
};

// 月末の誕生日: 同じ日が無い月は月末。いつも生年月日から数え、前の節目から足し継がない
assert.equal(iso(c.addMonths(d('2027-01-31'), 1)), '2027-02-28');
assert.equal(iso(c.addMonths(d('2028-01-31'), 1)), '2028-02-29');
assert.equal(iso(c.addMonths(d('2027-01-31'), 2)), '2027-03-31');
assert.equal(iso(c.addMonths(d('2027-01-31'), 3)), '2027-04-30');
assert.equal(iso(c.addMonths(d('2026-08-31'), 6)), '2027-02-28');
assert.equal(iso(c.addMonths(d('2028-02-29'), 12)), '2029-02-28');
assert.equal(c.monthsBetween(d('2027-01-31'), d('2027-02-27')), 0);
assert.equal(c.monthsBetween(d('2027-01-31'), d('2027-02-28')), 1);
assert.equal(c.monthsBetween(d('2027-01-31'), d('2027-03-30')), 1);
assert.equal(c.monthsBetween(d('2027-01-31'), d('2027-03-31')), 2);
assert.equal(c.parseDay('2027-02-29'), null);
const eom = plan('2027-01-31', '2027-02-01');
assert.equal(iso(eom.milestones.find((m) => m.key === 'm1').date), '2027-02-28');
assert.equal(iso(eom.milestones.find((m) => m.key === 'm5').date), '2027-06-30');
const teote = item(eom, 'sapporo-childcare-byouji-teote-account');
assert.equal(iso(teote.start), '2027-06-30');
assert.equal(iso(teote.due), '2027-05-31'); // recommended_lead_days 30 を引く
assert.equal(teote.dueKind, 'guide');

// 祝日（振替休日・国民の休日を含む）と土日・年末年始
const holidays = {
  '2026-01-12': '成人の日',
  '2026-03-20': '春分の日',
  '2026-05-06': '振替休日', // 5/3 が日曜
  '2026-09-21': '敬老の日',
  '2026-09-22': '国民の休日', // 敬老の日と秋分の日にはさまれる
  '2026-09-23': '秋分の日',
  '2026-11-23': '勤労感謝の日',
  '2027-01-11': '成人の日',
  '2027-03-22': '振替休日', // 春分の日 3/21 が日曜
};
for (const [k, v] of Object.entries(holidays)) assert.equal(c.holidayName(d(k)), v, k);
for (const k of ['2026-05-07', '2026-09-24', '2026-11-24', '2027-03-23']) assert.equal(c.holidayName(d(k)), null, k);
assert.equal(c.closedReason(d('2026-11-07')), '土曜');
assert.equal(c.closedReason(d('2026-11-08')), '日曜');
assert.equal(c.closedReason(d('2026-11-06')), null);
assert.equal(c.closedReason(d('2026-12-29')), '年末年始');
assert.equal(c.closedReason(d('2026-12-30')), '年末年始');
assert.equal(c.closedReason(d('2027-01-04')), null);
assert.equal(iso(c.prevOpen(d('2026-09-23'))), '2026-09-18');
assert.equal(iso(c.nextOpen(d('2026-09-19'))), '2026-09-24');

// 児童手当の支給予定日: 偶数月の 13 日、土日祝なら前日。出典にある令和 8 年度の予定日と一致する
const payEvent = data.events.find((e) => e.id === 'child-allowance-sapporo-payment-day');
const official = [...payEvent.ev.matchAll(/(\d+)月(\d+)日（/g)].map((m) => [+m[1], +m[2]]);
assert.equal(official.length, 6);
for (const [m, day] of official) {
  const y = m >= 4 ? 2026 : 2027;
  const want = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  assert.equal(iso(c.allowancePayDay(y, m, 13)), want, want);
}

// 締切が閉庁日: 出典に決まりが無い出生届は、締切を動かさず前の開庁日を添える
const sunday = item(plan('2026-09-07', '2026-09-08'), 'sapporo-procedures-shussho-todoke');
assert.equal(iso(sunday.due), '2026-09-20'); // 出生日 + 13（初日起算）
assert.equal(sunday.closed.reason, '日曜');
assert.equal(iso(sunday.closed.before), '2026-09-18');
assert.equal(sunday.closed.after, null);
assert.equal(iso(sunday.effDue), '2026-09-20');
// 児童手当は出典に「閉庁日なら翌開庁日まで」とあるので、敬老の日・国民の休日・秋分の日を越えて 9/24 にする
const teate = item(plan('2026-09-06', '2026-09-08'), 'sapporo-procedures-jido-teate');
assert.equal(iso(teate.due), '2026-09-21');
assert.equal(teate.closed.reason, '敬老の日');
assert.equal(iso(teate.effDue), '2026-09-24');
assert.equal(iso(teate.closed.before), '2026-09-18');
// 開庁日の締切には印を付けない
assert.equal(item(plan('2026-09-01', '2026-09-02'), 'sapporo-procedures-jido-teate').closed, null);

// 期限が過去の項目
const ex = plan('2026-08-31', '2026-11-07', { nursery: '2027-04', work: '2027-04-05' });
assert.equal(item(ex, 'sapporo-procedures-shussho-todoke').status.key, 'overdue');
assert.equal(item(ex, 'sapporo-procedures-jido-teate').status.text, '締切を 53 日過ぎた');
assert.deepEqual(ex.items.filter((p) => p.status.key === 'overdue').map((p) => p.id).sort(), [
  'national-procedures-kenpo-hifuyosha-tsuika',
  'national-procedures-sango-papa-ikukyu',
  'national-procedures-shusseigo-kyugyo-shien',
  'sapporo-procedures-jido-teate',
  'sapporo-procedures-kokuho-kanyu',
  'sapporo-procedures-shussho-todoke',
]);
// 済んだ項目は期限切れにしない
const done = plan('2026-08-31', '2026-11-07', { done: { 'sapporo-procedures-shussho-todoke': true } });
assert.equal(item(done, 'sapporo-procedures-shussho-todoke').status.key, 'done');
// 締切の当日はまだ過ぎていない。翌日に過ぎる
const due = item(plan('2026-08-31', '2026-11-30'), 'sapporo-procedures-hoikusho-4gatsu-nyusho-r9');
assert.equal(due.status.key, 'open');
assert.equal(due.status.text, '今日が締切');
assert.equal(due.dueTime, '17:15');
assert.equal(item(plan('2026-08-31', '2026-12-01'), 'sapporo-procedures-hoikusho-4gatsu-nyusho-r9').status.key, 'overdue');
// 予防接種は過ぎても期限切れ（赤）にしない。流行期が終わったら「今季は終わった」
const older = plan('2022-01-15', '2026-03-01');
assert.equal(item(plan('2025-01-15', '2026-03-01'), 'sapporo-vaccines-influenza-first').status.key, 'season-over');
assert.match(item(plan('2025-01-15', '2026-03-01'), 'sapporo-vaccines-influenza-first').status.text, /^今季は終わった。次は 10\/1（木） から$/);
assert.equal(item(older, 'sapporo-vaccines-mumps-subsidy').status.key, 'ended');
assert.ok(older.items.filter((p) => p.lane === 'vaccines').every((p) => p.status.key !== 'overdue'));
assert.equal(item(plan('2025-01-15', '2025-12-01'), 'sapporo-vaccines-influenza-first').status.key, 'open');

// before_milestone: 入園予定月が無ければ期日を出さない
const noNursery = plan('2026-08-31', '2026-11-07');
const kaoawase = item(noNursery, 'sapporo-childcare-kosapo-kaoawase');
assert.equal(kaoawase.due, null);
assert.equal(kaoawase.noDate, '入園予定月を入れると期日が出ます');
assert.equal(kaoawase.status.key, 'nodate');
assert.equal(iso(item(ex, 'sapporo-childcare-kosapo-kaoawase').due), '2027-03-02'); // 2027-04-01 の 30 日前

// recommended_lead_days と prep_days から「いつまでに・いつから」
const tsuen = item(ex, 'sapporo-childcare-daredemo-tsuen');
assert.equal(iso(tsuen.start), '2027-02-28');
assert.equal(iso(tsuen.due), '2027-01-14'); // 45 日前
assert.equal(iso(tsuen.prep), '2026-12-15'); // さらに 30 日前
// 生まれたときから使える項目で目安を引くと生まれる前になる。そのときは日付を出さない
const nendo = item(ex, 'sapporo-procedures-hoikusho-nendotochu');
assert.equal(nendo.due, null);
assert.match(nendo.noDue, /60 日前/);
// 入園予定月で保育園の条件を絞る
assert.equal(iso(item(ex, 'sapporo-procedures-hoikuryo-tashi-keigen').start), '2027-04-01');
assert.equal(iso(item(ex, 'sapporo-childcare-ichiji-azukari').end), '2027-03-31');
assert.equal(iso(item(ex, 'sapporo-childcare-kyujitsu-hoiku-register').due), '2027-03-02');

// 入力で判定できない条件は要確認のまま渡す
assert.equal(item(ex, 'sapporo-procedures-kodomo-iryohi').item.nc, true);
assert.ok(item(ex, 'sapporo-procedures-kodomo-iryohi').item.check.length > 0);

// クラス年齢: 4 月 1 日の時点の満年齢（4 月 1 日生まれは上の学年）
assert.equal(c.classAge(d('2026-04-01'), 2027), 1);
assert.equal(c.classAge(d('2026-04-02'), 2027), 0);
assert.ok(ex.events.bands.some((b) => b.text.startsWith('0 歳児クラス') && iso(b.start) === '2027-04-01' && iso(b.end) === '2028-03-31'));

assert.equal(c.todayJst(Date.UTC(2026, 10, 6, 15, 0)), d('2026-11-07')); // UTC 15 時は JST の翌日 0 時

// 小学校入学: 満 6 歳になった日の翌日以後の最初の 4 月 1 日（4 月 1 日生まれは上の学年）
assert.equal(iso(c.schoolEntry(d('2020-04-01'))), '2026-04-01');
assert.equal(iso(c.schoolEntry(d('2020-04-02'))), '2027-04-01');
assert.equal(iso(c.schoolEntry(d('2020-01-15'))), '2026-04-01');
assert.equal(iso(c.schoolEntry(d('2026-08-31'))), '2033-04-01');
assert.equal(iso(c.schoolEntry(d('2028-02-29'))), '2034-04-01');
assert.equal(ex.milestones.at(-1).key, 'school');

// 年表のラベル: 括弧の中を外し、22 文字を超えたら省く。幅の見積もりは全角を半角より広く
assert.equal(c.roadmapLabel('産後パパ育休（出生時育児休業）の申出（出生後 8 週間以内に 4 週間まで）'), '産後パパ育休の申出');
assert.equal(c.roadmapLabel('児童手当（3 歳未満）は月 15,000 円', true), '児童手当（3 歳未満）は月 15,000 円');
const long = c.roadmapLabel('病児・病後児保育（こどもデイサービス）の予約システム「テオテ」のアカウント作成');
assert.equal(Array.from(long).length, 22);
assert.ok(long.endsWith('…'));
assert.ok(c.textWidth('あいう') > c.textWidth('abc'));
assert.equal(c.textWidth(''), 2);

// 段ずらし: 前の段の右端 + すき間より右から始まる最初の段に入れる
const ends = [];
assert.equal(c.packRow(ends, 0, 100), 0);
assert.equal(c.packRow(ends, 50, 120), 1); // 0 段目と重なる
assert.equal(c.packRow(ends, 100 + c.GAP, 200), 0); // すき間ちょうどなら同じ段
assert.equal(c.packRow(ends, 100 + c.GAP + 1, 210), 2); // 0 段目は 200 まで埋まった。1 段目も 120 + GAP > 107
assert.deepEqual(ends, [200, 120, 210]);

// 年表の棒と点: 準備を始める日から期限までが棒、1 日だけのものは点
const L = c.layoutRoadmap(ex);
const els = (id) => L.lanes.flatMap((l) => l.els).filter((g) => g.id === id);
const one = (id) => { const list = els(id); assert.equal(list.length, 1, id); return list[0]; };
let g = one('sapporo-childcare-daredemo-tsuen'); // prep_days あり
assert.deepEqual([g.kind, iso(g.a), iso(g.z), g.mark], ['bar', '2026-12-15', '2027-01-14', 'gd']);
g = one('national-procedures-sango-papa-ikukyu'); // 公式の締切と prep_days
assert.deepEqual([g.kind, iso(g.a), iso(g.z), g.mark, g.past, g.over], ['bar', '2026-10-12', '2026-10-26', 'dl', true, true]);
g = one('sapporo-procedures-shussho-todoke'); // 受付が始まる日から締切まで
assert.deepEqual([g.kind, iso(g.a), iso(g.z), g.mark, g.past], ['bar', '2026-08-31', '2026-09-13', 'dl', true]);
g = one('sapporo-procedures-hoikusho-4gatsu-nyusho-r9'); // 1 日だけ
assert.deepEqual([g.kind, iso(g.a), g.mark, g.past, g.nc], ['point', '2026-11-30', 'dl', false, true]);
g = one('sapporo-procedures-kodomo-iryohi'); // 締切なし: 始まる日の点。対象の期間中は薄くしない
assert.deepEqual([g.kind, iso(g.a), g.mark, g.past, g.nc], ['point', '2026-08-31', 'st', false, true]);
g = one('sapporo-childcare-kosapo-kaoawase'); // before_milestone: 目安の日から入園予定月まで
assert.deepEqual([g.kind, iso(g.a), iso(g.z), g.mark], ['bar', '2027-03-02', '2027-04-01', 'gd']);
assert.equal(els('sapporo-vaccines-influenza-first').length, 5); // 毎年の受けられる時期（入学まで）
assert.equal(els('sapporo-vaccines-influenza-second').length, 0); // 接種日を聞かないので置かない
assert.ok(L.lanes.find((l) => l.key === 'vaccines').els.every((x) => x.mark !== 'dl')); // 予防接種に締切の印を付けない
assert.deepEqual(Array.from(L.lanes, (l) => l.key), ['milestone', 'procedures', 'vaccines', 'childcare_registration', 'events']);
// 入園予定月が無ければ before_milestone は置かず、何件出るかを返す
const L0 = c.layoutRoadmap(noNursery);
assert.deepEqual(Array.from(L0.skipped.filter((s) => s.milestone === 'nursery_start'), (s) => s.id), ['sapporo-childcare-kosapo-kaoawase']);
assert.ok(!L0.lanes.flatMap((l) => l.els).some((x) => x.id === 'sapporo-childcare-kosapo-kaoawase'));
// マイルストーン: 4 日しか離れていない入園予定月と復職予定日は、段を分ける
const ms = L.lanes[0];
const nursery = ms.els.find((x) => x.id === 'ms-nursery');
const work = ms.els.find((x) => x.id === 'ms-work');
assert.equal(work.a - nursery.a, 4);
assert.notEqual(nursery.row, work.row);
assert.deepEqual(ms.els.map((x) => x.id).filter((id) => /^ms-(birth|m1|m5|m6|m12|nursery|work|school)$/.test(id)).length, 8);
// 範囲は誕生から小学校入学まで。今日の線もその中
assert.ok(L.r0 <= ex.ctx.birth && L.r1 >= ex.ctx.school && L.today > 0 && L.today < L.width);

// 段ずらしと文字の重なり: いろいろな入力で、同じ段の印・棒・ラベル（見積もり幅）が重ならず、
// ラベルと印がその要素の幅の中に収まる
function checkLayout(layout, label) {
  for (const lane of layout.lanes) {
    const bad = c.overlaps(lane);
    assert.equal(bad.length, 0, `${label} ${lane.key}: ${JSON.stringify(bad)}`);
    for (const x of lane.els) {
      assert.ok(Number.isInteger(x.row) && x.row >= 0 && x.row < lane.rows, `${label} ${x.id} の段`);
      if (x.label) assert.ok(x.labelX >= x.x0 && x.labelX + x.labelW <= x.x1, `${label} ${x.id} のラベル`);
      assert.ok(x.xa >= x.x0 - 0 && x.xz <= x.x1, `${label} ${x.id} の印`);
    }
  }
}
checkLayout(L, '架空の例');
checkLayout(L0, '入園予定月なし');
let seed = 20261107;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
for (let k = 0; k < 150; k++) {
  const b = d('2015-01-01') + rand(365 * 21);
  const today = b + rand(365 * 8) - 200;
  const extra = {};
  if (rand(2)) { const nm = c.ymd(c.addMonths(b, 3 + rand(40))); extra.nursery = `${nm.y}-${String(nm.m).padStart(2, '0')}`; }
  if (rand(2)) extra.work = iso(b + 150 + rand(700));
  const pl = c.planAll(data, { birth: iso(b), ...extra }, today);
  checkLayout(c.layoutRoadmap(pl), `${iso(b)} ${JSON.stringify(extra)} 今日 ${iso(today)}`);
  // 2 人の家族（下の子は 1〜5 年あと）
  const y = b + 365 + rand(365 * 4);
  const st = { elderBirth: iso(b), elderNursery: extra.nursery || '', youngerDue: iso(Math.min(y, d('2036-12-31'))), youngerNursery: '', ward: '', work: extra.work || '' };
  const fm = c.planFamily(data, st, today, {});
  for (const v of ['all', 'a', 'b']) checkLayout(c.layoutFamily(fm, v), `家族 ${JSON.stringify(st)} ${v}`);
}

// ---- 子ども 2 人と設定 ----
// メイン画面（見出しと年表・詳細）の HTML に入力欄が無い。入力欄は設定画面（#settings-view）だけ
const mainHtml = html.slice(html.indexOf('<body>'), html.indexOf('<section id="settings-view"'));
assert.ok(mainHtml.includes('<div id="main-view">'));
assert.ok(!/<input|<select|<textarea/.test(mainHtml), 'メイン画面に入力欄がある');
const settingsHtml = html.slice(html.indexOf('<section id="settings-view"'), html.indexOf('</section>', html.indexOf('<section id="settings-view"')));
for (const id of ['s-elderBirth', 's-elderNursery', 's-youngerDue', 's-youngerNursery', 's-ward', 's-work', 's-remember', 'b-reset']) assert.ok(settingsHtml.includes(`id="${id}"`), id);

// 初期値（すべて架空）: 上の子は 2026-11-07 の時点で 1 歳
const today = d('2026-11-07');
assert.deepEqual({ ...c.DEFAULT_SETTINGS }, { elderBirth: '2025-11-07', elderNursery: '2027-04', youngerDue: '2027-03-15', youngerNursery: '', ward: '北区', work: '2028-04-03' });
const fam = c.planFamily(data, c.DEFAULT_SETTINGS, today, {});
assert.equal(fam.children.length, 2);
assert.equal(c.conditionText(fam), '上の子 1 歳 0 か月・下の子 2027 年 3 月 15 日予定（日は仮）・北区・復職予定 2028/4/3（月）・架空の例');
assert.equal(c.ageYM(d('2025-11-07'), d('2026-11-06')), '0 歳 11 か月');
// 下の子の日付を手計算で照合する（出産予定日 2027-03-15 から）
const younger = fam.children[1].plan;
const yItem = (id) => item(younger, id);
assert.equal(iso(yItem('sapporo-procedures-jido-teate').effDue), '2027-03-30'); // 3/15 + 15 日 = 3/30（火）。開庁日なのでずらさない
assert.equal(yItem('sapporo-procedures-jido-teate').closed, null);
assert.equal(iso(yItem('sapporo-procedures-shussho-todoke').due), '2027-03-28'); // 3/15 + 13 日 = 3/28（日）
assert.equal(iso(yItem('sapporo-procedures-shussho-todoke').closed.before), '2027-03-26'); // 前の開庁日は 3/26（金）
assert.equal(iso(c.addMonths(d('2027-03-15'), 5)), '2027-08-15'); // 生後 5 か月
assert.equal(iso(yItem('sapporo-childcare-byouji-teote-account').due), '2027-07-16'); // 8/15 の 30 日前 = 7/16
assert.equal(iso(younger.ctx.school), '2033-04-01');
assert.equal(iso(fam.children[0].plan.ctx.school), '2032-04-01');
// 下の子が生まれる前に締切が来る申込は、下の子には出さない（データの対象月齢 0 か月〜に当たらない）
assert.equal(yItem('sapporo-procedures-hoikusho-4gatsu-nyusho-r9').status.key, 'na');
assert.equal(item(fam.children[0].plan, 'sapporo-procedures-hoikusho-4gatsu-nyusho-r9').status.key, 'open');
// 第 2 子以降に関わる制度は、データの「要確認」のまま
assert.equal(yItem('sapporo-procedures-hoikuryo-tashi-keigen').item.nc, true);
// 下の子は入園予定月が空なので、before_milestone は期日なし
assert.equal(yItem('sapporo-childcare-kosapo-kaoawase').noDate, '入園予定月を入れると期日が出ます');

// 「済んだ」は子どもごとに分ける
const famDone = c.planFamily(data, c.DEFAULT_SETTINGS, today, { 'a:sapporo-procedures-shussho-todoke': true });
assert.equal(item(famDone.children[0].plan, 'sapporo-procedures-shussho-todoke').status.key, 'done');
assert.notEqual(item(famDone.children[1].plan, 'sapporo-procedures-shussho-todoke').status.key, 'done');
assert.equal(c.doneKey('b', 'x'), 'b:x');

// 設定を変えると日付が変わる。保存した形から読み直しても同じ。初期値に戻せる
const changed = c.normalizeSettings({ ...c.DEFAULT_SETTINGS, elderBirth: '2025-12-01' });
const famChanged = c.planFamily(data, changed, today, {});
assert.equal(iso(item(famChanged.children[0].plan, 'sapporo-procedures-shussho-todoke').due), '2025-12-14');
assert.notEqual(iso(item(famChanged.children[0].plan, 'sapporo-procedures-shussho-todoke').due), iso(item(fam.children[0].plan, 'sapporo-procedures-shussho-todoke').due));
assert.deepEqual({ ...c.normalizeSettings(JSON.parse(JSON.stringify({ settings: changed })).settings) }, { ...changed });
assert.equal(c.isDefaultSettings(changed), false);
assert.equal(c.isDefaultSettings(c.normalizeSettings(c.DEFAULT_SETTINGS)), true);
assert.match(c.conditionText(famChanged), /あなたの設定$/);
// 片方を空にすれば 1 人分。両方空なら設定を促す
assert.deepEqual(Array.from(c.planFamily(data, { ...c.DEFAULT_SETTINGS, youngerDue: '' }, today, {}).children, (k) => k.key), ['a']);
assert.deepEqual(Array.from(c.planFamily(data, { ...c.DEFAULT_SETTINGS, elderBirth: '' }, today, {}).children, (k) => k.key), ['b']);
assert.equal(c.planFamily(data, { ...c.DEFAULT_SETTINGS, elderBirth: '', youngerDue: '' }, today, {}).children.length, 0);
assert.ok(c.settingsErrors({ ...c.DEFAULT_SETTINGS, elderBirth: '', youngerDue: '' })[0].includes('入れてください'));
assert.equal(c.settingsErrors(c.DEFAULT_SETTINGS, ['北区']).length, 0);
assert.equal(c.settingsErrors({ ...c.DEFAULT_SETTINGS, elderNursery: '2027/4' }).length, 1);

// 2 人の年表: 項目の ID は子ごとに分かれて重ならない。範囲は 2 人の全期間
const FL = c.layoutFamily(fam, 'all');
const famEls = FL.lanes.flatMap((l) => Array.from(l.els));
const itemEls = famEls.filter((g) => g.lane !== 'events' && g.lane !== 'milestone');
assert.ok(itemEls.every((g) => /^[ab]-/.test(g.id) && g.id === (g.who === '上' ? 'a-' : 'b-') + g.item));
assert.ok(itemEls.some((g) => g.id === 'a-sapporo-procedures-shussho-todoke') && itemEls.some((g) => g.id === 'b-sapporo-procedures-shussho-todoke'));
const detailIds = [];
for (const k of fam.children) {
  for (const p of k.plan.items) detailIds.push(`${k.key}-${p.id}`);
  for (const m of k.plan.milestones) if (m.kind !== 'work') detailIds.push(`${k.key}-ms-${m.key}`);
}
detailIds.push('ms-work', ...data.events.map((e) => e.id), 'ward');
assert.equal(new Set(detailIds).size, detailIds.length, '詳細の ID が重なる');
assert.ok(famEls.every((g) => detailIds.includes(g.id)), '年表の要素がどの詳細にも当たらない');
assert.equal(famEls.filter((g) => g.id === 'ms-work').length, 1); // 復職予定日は家庭で 1 つ
assert.ok(FL.r0 <= d('2025-11-07') && FL.r1 >= d('2033-04-01'));
assert.equal(Array.from(FL.kids, (k) => k.mark).join(''), '上下');
// 表示の絞り込み: 下の子だけ
const FLb = c.layoutFamily(fam, 'b');
assert.ok(FLb.lanes.flatMap((l) => Array.from(l.els)).filter((g) => g.lane !== 'events' && g.id !== 'ms-work').every((g) => g.id.startsWith('b-')));
// 2 人で同じ日の支給予定日は 1 つにまとめる
const pays = FL.lanes.find((l) => l.key === 'events').els.filter((g) => g.kind === 'dot').map((g) => g.a);
assert.equal(new Set(pays).size, pays.length);
for (const lane of FL.lanes) assert.equal(c.overlaps(lane).length, 0, `2 人 ${lane.key}`);

(async () => {
  const build = await import(pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'build-sapporo-roadmap.mjs')).href);
  // YAML のパーサ: data/items/ で使う書き方
  const y = build.parseYaml([
    'events:',
    '- id: a # コメント',
    "  note: 'one: two,",
    "    three''s'",
    '  plain: 行の',
    '    続き',
    '  flow: { from: 5, to: null }',
    '  list: [育休中, "復職予定"]',
    '  empty:',
    '  num: 19.3',
  ].join('\n'));
  assert.deepEqual(y, { events: [{ id: 'a', note: "one: two, three's", plain: '行の 続き', flow: { from: 5, to: null }, list: ['育休中', '復職予定'], empty: null, num: 19.3 }] });
  assert.deepEqual(build.sentences('要確認: A（B。C）。必要なもの: D。'), ['要確認: A（B。C）。', '必要なもの: D。']);
  // 埋め込みデータが YAML から作り直したものと一致し、data/items/ の全項目がある
  assert.deepEqual(data, build.buildData());
  const yaml = build.loadYaml();
  assert.deepEqual(data.items.map((x) => x.id), yaml.items.map((x) => x.id));
  assert.deepEqual(data.events.map((x) => x.id), yaml.events.map((x) => x.id));
  assert.deepEqual(data.wards.map((x) => x.name), yaml.wards.map((x) => x.name));
  // どの入力でも、起きうることはすべて年表に出るか、出さない理由がある
  for (const pl of [ex, noNursery, older]) {
    assert.equal(pl.items.length, yaml.items.length);
    for (const e of data.events) assert.ok(pl.events.placed[e.id] || pl.events.undated.some((u) => u.id === e.id && u.reason), e.id);
  }
  console.log('OK: 月末の誕生日・祝日と土日と年末年始・支給予定日・閉庁日の締切・期限切れ・予防接種の扱い・入園予定月なし・目安と準備の日・就学・年表の棒と点・段ずらしと文字の重なり・子ども 2 人と設定・YAML と埋め込みの一致');
  await browserChecks();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---- ブラウザでの検査（playwright と Chromium があるときだけ。無ければ省いたと出す） ----
async function browserChecks() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (e) { console.log('省略: playwright が見つからないので、ブラウザでの検査をしていない'); return; }
  const url = pathToFileURL(path.join(__dirname, 'sapporo-roadmap.html')).href + '?today=2026-11-07';
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => { if (!/^(file|data|about):/.test(r.url())) errors.push('外への通信 ' + r.url()); });
    await page.goto(url);
    // メイン画面に input と select が無い（詳細の「済んだ」のチェックを除く）
    const stray = await page.evaluate(() => [...document.querySelectorAll('input, select, textarea')].filter((e) => !e.closest('#settings-view') && !(e.type === 'checkbox' && e.closest('details.item'))).length);
    assert.equal(stray, 0);
    assert.equal(await page.isVisible('#settings-view'), false);
    assert.ok((await page.textContent('#cond')).startsWith('上の子 1 歳 0 か月'));
    assert.ok(await page.isVisible('#rm'));
    // ID が重ならない
    const dup = await page.evaluate(() => { const a = [...document.querySelectorAll('[id]')].map((e) => e.id); return a.length - new Set(a).size; });
    assert.equal(dup, 0);
    // 年表のリンクを押すと、それぞれの子の詳細へ飛ぶ
    for (const id of ['a-sapporo-procedures-shussho-todoke', 'b-sapporo-procedures-shussho-todoke']) {
      await page.evaluate((i) => document.querySelector(`.el[data-id="${i}"]`).click(), id);
      assert.equal(await page.evaluate((i) => document.getElementById('item-' + i).open, id), true, id);
      assert.equal(await page.evaluate(() => decodeURIComponent(location.hash)), '#item-' + id);
    }
    const titleA = () => page.getAttribute('.el[data-id="a-sapporo-procedures-shussho-todoke"]', 'title');
    assert.match(await titleA(), /2025\/11\/20/); // 2025-11-07 + 13 日
    // 設定を変えると年表の日付が変わる
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForSelector('#settings-view:not([hidden])');
    await page.fill('#s-elderBirth', '2025-12-01');
    await page.dispatchEvent('#s-elderBirth', 'change');
    await page.click('#back-main');
    await page.waitForSelector('#main-view:not([hidden])');
    assert.match(await titleA(), /2025\/12\/14/);
    assert.ok((await page.textContent('#cond')).endsWith('あなたの設定'));
    // 保存を選ばなければ、このブラウザに残さない（再読み込みで初期値に戻る）
    const stored = () => page.evaluate(() => localStorage.getItem('sapporo-roadmap:v2'));
    assert.equal(await stored(), null);
    await page.reload();
    assert.match(await titleA(), /2025\/11\/20/);
    // 保存を選ぶと、再読み込みしても残る
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForSelector('#settings-view:not([hidden])');
    assert.equal(await page.isChecked('#s-remember'), false);
    await page.fill('#s-elderBirth', '2025-12-01');
    await page.dispatchEvent('#s-elderBirth', 'change');
    assert.doesNotMatch(await page.textContent('#settings-msg'), /保存しました/);
    await page.check('#s-remember');
    assert.match(await page.textContent('#settings-msg'), /保存しました（このブラウザの中だけ）/);
    assert.equal(JSON.parse(await stored()).settings.elderBirth, '2025-12-01');
    await page.click('#back-main');
    await page.waitForSelector('#main-view:not([hidden])');
    await page.reload();
    assert.match(await titleA(), /2025\/12\/14/);
    // 初期値に戻す
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForSelector('#settings-view:not([hidden])');
    assert.equal(await page.isChecked('#s-remember'), true);
    assert.equal(await page.inputValue('#s-elderBirth'), '2025-12-01');
    await page.click('#b-reset');
    assert.equal(await page.inputValue('#s-elderBirth'), '2025-11-07');
    await page.click('#back-main');
    await page.waitForSelector('#main-view:not([hidden])');
    assert.match(await titleA(), /2025\/11\/20/);
    assert.ok((await page.textContent('#cond')).endsWith('架空の例'));
    // 下の子を空にすると 1 人分
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForSelector('#settings-view:not([hidden])');
    await page.fill('#s-youngerDue', '');
    await page.dispatchEvent('#s-youngerDue', 'change');
    await page.click('#back-main');
    await page.waitForSelector('#main-view:not([hidden])');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.el[data-id^="b-"]').length), 0);
    assert.equal(await page.textContent('#views'), '');
    // 保存をやめると、保存した値を消す
    await page.evaluate(() => { location.hash = '#settings'; });
    await page.waitForSelector('#settings-view:not([hidden])');
    assert.equal(JSON.parse(await stored()).settings.youngerDue, '');
    await page.uncheck('#s-remember');
    assert.equal(await stored(), null);
    await page.fill('#s-elderBirth', '2025-10-01');
    await page.dispatchEvent('#s-elderBirth', 'change');
    assert.equal(await stored(), null);
    assert.doesNotMatch(await page.textContent('#settings-msg'), /保存しました/);
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log('OK（ブラウザ）: メイン画面に入力欄なし・上の子 1 歳・各子の詳細へのリンク・ID の重複なし・設定の変更・保存を選んだときだけ残す・やめたら消す・初期値に戻す・1 人分');
  } finally {
    await browser.close();
  }
}
