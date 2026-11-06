// 実行: node docs/prototypes/hospital-preparation.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname,'hospital-preparation.html'),'utf8');
const model = html.match(/<script id="model">([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({});
vm.runInContext(model,context);
const input = {cash:300000,low:30000,high:70000,fixed:150000,benefit:200000,benefitDate:'2026-12-09',count:1,perPayment:10000};
const normal = context.calculate(input);
assert.equal(normal.with.low.shortfall,0);
assert.equal(normal.with.high.shortfall,12940);
assert.equal(normal.with.high.firstShortfall,'2026-11-30');
assert.equal(normal.without.low.shortfall,180000);
assert.equal(normal.without.high.shortfall,220000);
assert.equal(normal.noBenefit.high.shortfall,22940);

// 最後には黒字でも、給付の前に不足することを取りこぼさない。
const delayed = context.calculate({...input,benefitDate:'2026-12-23'});
assert.equal(delayed.with.high.shortfall,22940);
assert.equal(delayed.with.high.rows.at(-1).balance,177060);
assert.ok(delayed.with.high.shortfall > normal.with.high.shortfall);

const none = context.calculate({...input,benefitDate:'none',count:3});
assert.equal(none.with.high.shortfall,42940);
assert.equal(none.extraTotal,30000);
assert.equal(none.with.high.rows.length,6);
const zero = context.calculate({...input,benefitDate:'none',count:0,low:70000});
assert.equal(zero.with.low.shortfall,12940);
assert.equal(zero.with.high.shortfall,12940);
assert.equal(zero.extraTotal,0);

// 同日に支払いと入金があるときは、入金前に必要になるお金を計上する。
const sameDay = context.ledger(100,[
  {date:'2026-11-16',label:'入金',amount:100},
  {date:'2026-11-16',label:'支払い',amount:-150}
]);
assert.equal(sameDay.shortfall,50);
assert.equal(sameDay.rows.at(-1).balance,50);

for (const change of [{cash:NaN},{benefit:-1},{low:80000},{count:4},{perPayment:1.5},{benefitDate:'2026-12-10'},{cash:10000001}]) {
  assert.throws(() => context.calculate({...input,...change}));
}
const enough = context.calculate({...input,cash:1000000});
assert.equal(enough.without.high.shortfall,0);
assert.equal(enough.without.high.firstShortfall,null);
console.log('OK: 金額の幅・給付の遅れ・途中の不足・回数0/3・未入金・同日順序・入力エラー');
