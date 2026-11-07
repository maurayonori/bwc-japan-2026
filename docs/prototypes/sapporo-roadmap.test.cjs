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
}

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
  console.log('OK: 月末の誕生日・祝日と土日と年末年始・支給予定日・閉庁日の締切・期限切れ・予防接種の扱い・入園予定月なし・目安と準備の日・就学・年表の棒と点・段ずらしと文字の重なり・YAML と埋め込みの一致');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
