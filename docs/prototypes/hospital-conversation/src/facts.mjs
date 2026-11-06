import { deepFreeze } from './validate.mjs';

// Claude に渡す「持っている事実」。会話で制度や手続きに触れるときは、ここにあることだけを事実として使う。
// 元は docs/research/hospital-money-facts-20261105.md。足す・変えるときは、出典を開いて確かめてから書く。
//
// verified:
//   'primary'     … 2026-11-06 に、出典の本文と突き合わせた
//   'transcribed' … 2026-11-05 に、サブエージェントが出典から書き起こした。本文との照合はまだ

const source = (name, url) => ({ name, url });

export const FACTS = deepFreeze([
  {
    id: 'F01',
    topic: '高額療養費は月ごとに計算する',
    text: '高額療養費の上限は、「同一の月」（1 日〜末日）に医療機関で払った自己負担について計算される。入院が月をまたぐと、月ごとに分けて計算される。',
    sources: [source('全国健康保険協会', 'https://www.kyoukaikenpo.or.jp/benefit/high_cost_medical_expenses/index.html')],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F02',
    topic: 'マイナ保険証と窓口での上限',
    text: 'マイナ保険証で限度額情報を確認できる場合、限度額適用認定証が無くても、保険診療の窓口負担を上限までにできる。同じ月・同じ医療機関でも入院と外来は別で、食事代や差額ベッド代は含まない。オンライン資格確認に未対応、または協会けんぽにマイナンバーが未登録の場合は認定証が必要。住民税非課税などの低所得者には、別様式の減額認定申請の案内がある。',
    sources: [
      source('全国健康保険協会', 'https://www.kyoukaikenpo.or.jp/application_form/benefit/004/index.html'),
      source('厚生労働省', 'https://www.mhlw.go.jp/stf/newpage_40406.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F03',
    topic: '限度額適用認定証（協会けんぽ）',
    text: '協会けんぽの限度額適用認定証は、加入する支部への郵送か電子申請で申し込む。東京支部の案内では、不備がなければ受付から到着まで約 1 週間が目安。有効期間は申請月の初日（加入月なら資格取得日）から最長 1 年だが、2026 年 8 月以降の交付分は最長でも 2027 年 7 月 31 日まで。',
    sources: [
      source('全国健康保険協会', 'https://www.kyoukaikenpo.or.jp/benefit/high_cost_medical_expenses/001/index.html'),
      source('全国健康保険協会 申請方法・有効期間', 'https://www.kyoukaikenpo.or.jp/application_form/benefit/004/index.html'),
      source('全国健康保険協会 東京支部', 'https://www.kyoukaikenpo.or.jp/shibu/tokyo/assets/20241213021.pdf'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F04',
    topic: '限度額適用認定証（札幌市の国民健康保険）',
    text: '札幌市の国民健康保険では、区役所の保険年金課（厚別・清田・手稲は保険係）で申請する。オンライン申請もある。北区には篠路出張所での即日交付の案内がある。有効期間は申請した月の初日から 7 月末日まで。保険料の滞納があると交付されないことがある。',
    sources: [
      source('札幌市', 'https://www.city.sapporo.jp/hoken-iryo/kokuho/genndogaku.html'),
      source('札幌市北区', 'https://www.city.sapporo.jp/kitaku/tetsuzuki/hoken_nenkin/04_01.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F05',
    topic: 'あとから払い戻しを受ける場合の時期',
    text: '窓口で上限が適用されず、あとから高額療養費を申請した場合、払い戻しまで、協会けんぽは「診療月から 3 か月以上」、札幌市の国民健康保険は「通常、診療を受けた月から 3〜4 か月後」と案内している。申請できる期間は、診療月の翌月 1 日から 2 年。',
    sources: [
      source('全国健康保険協会 よくある質問', 'https://www.kyoukaikenpo.or.jp/faq/benefit/004/index.html'),
      source('全国健康保険協会 申請期限', 'https://www.kyoukaikenpo.or.jp/faq/benefit/001/index.html'),
      source('札幌市', 'https://www.city.sapporo.jp/hoken-iryo/kokuho/kogaku.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F06',
    topic: '高額医療費の貸付',
    text: '協会けんぽには、高額療養費の支給見込額の 8 割相当を無利子で貸す制度がある。札幌市の国民健康保険は、「保険給付」の手続き一覧に同じ貸付の記載が見つからない。制度が無いとは断定せず、区役所に確認する。',
    sources: [
      source('全国健康保険協会', 'https://www.kyoukaikenpo.or.jp/benefit/high_cost_medical_expenses/002/index.html'),
      source('札幌市 保険給付の手続き一覧', 'https://www.city.sapporo.jp/hoken-iryo/kokuho/hoken_kyufu.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F07',
    topic: '入院中の食事代',
    text: '入院中の食事代は、一般の区分で 1 食 550 円（2026 年 6 月 1 日から）。1 日の負担は 3 食ぶんまで。高額療養費の対象外。',
    sources: [source('全国健康保険協会', 'https://www.kyoukaikenpo.or.jp/benefit/mynumber_insurance_card/002/index.html')],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F08',
    topic: '差額ベッド代',
    text: '差額ベッド代は高額療養費の対象外。厚生労働省は、同意書による同意の確認が無い場合（室料や署名の欠落なども含む）、患者本人の治療上の必要で入った場合、病棟管理の必要などで入り実質的に患者の選択によらない場合を、料金を求めてはならない例としている。個別に当たるかは事情を確認して判断される。',
    sources: [
      source('厚生労働省', 'https://www.mhlw.go.jp/stf/newpage_22682.html'),
      source('厚生労働省 保医発 0327 第 6 号', 'https://www.mhlw.go.jp/content/12400000/15-3.pdf'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F09',
    topic: '民間の医療保険の請求の流れ',
    text: '民間の医療保険の書面請求の一例は、保険会社に連絡 → 請求書と所定の診断書の用紙を受け取る → 用意して提出。入院中や通院中でも請求できる。診断書を省略できる場合や書類を介さない手続きもある。必要書類は保険会社・保険種類・請求内容で異なるため、先に契約先へ確かめる。',
    sources: [
      source('生命保険協会 便利帳（2023 年改訂、p.18-19）', 'https://www.seiho.or.jp/data/publication/elderly/pdf/all.pdf'),
      source('アフラック 必要書類', 'https://www.aflac.co.jp/keiyaku/seikyu/contents/insurance_claim.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F10',
    topic: '診断書の作成にかかる日数と費用の例',
    text: '病院が生命保険用の診断書を作るのにかかる日数と費用の公表例: 鳥取県立中央病院は「受付後 2 週間程度」・5,830 円。文書料はほかに 5,940 円（大阪急性期・総合医療センター）、9,900 円（横浜市立脳卒中・神経脊椎センター）の例がある。病院ごとに違うので、入院する病院に確かめる。',
    sources: [
      source('鳥取県立中央病院', 'https://www.pref.tottori.lg.jp/280887.htm'),
      source('大阪急性期・総合医療センター', 'https://www.gh.opho.jp/gh2025/wp-content/uploads/2026/01/revisionfees2026.pdf'),
      source('横浜市立脳卒中・神経脊椎センター', 'https://www.city.yokohama.lg.jp/kenko-iryo-fukushi/kenko-iryo/byoin/ybsc/notice/bunshoryou1.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F11',
    topic: '診断書を省ける条件の例',
    text: '診断書の代わりに領収書や申告書などで請求できる場合があるが、入院日数だけでは判断できない。アフラックの医療保険等では、契約からの期間・日数、手術や放射線治療の請求がないこと、対象外の給付金がないことなどの条件と例外がある。オリックス生命の書面請求にも、保障開始からの期間・日数、退院済み、手術日数、請求する給付や保険種類、病名などの条件がある。広島県民共済のアップロード請求は別の仕組みで、加入状況・退院済み・必要書類などの条件がある。全国の共済一般には広げず、診断書を頼む前に契約先へ必要書類を確かめる。',
    sources: [
      source('アフラック', 'https://www.aflac.co.jp/keiyaku/seikyu/contents/insurance_claim.html'),
      source('オリックス生命', 'https://faq.orixlife.co.jp/faq_detail.html?id=8400351'),
      source('県民共済の例（広島）', 'https://hiroshima.kyosai-cc.or.jp/service/upload.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F12',
    topic: '給付金が支払われるまでの日数の例',
    text: 'メットライフ生命のよくある質問では、必要書類が到着した日の翌日から 5 営業日以内に支払い、円口座への着金は支払日の翌銀行営業日と案内している。土日祝日と同社の年末年始休業日は営業日に含まない。一部の給付には別の取扱いがあり、書類の不備や事実確認で遅れる場合もある。入金日の確約として扱わず、具体的な日付と条件は契約先に確かめる。',
    sources: [source('メットライフ生命 よくある質問', 'https://faq.metlife.co.jp/answer/675187615a7cb3a9ba2b8571/')],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F13',
    topic: '給付金を請求する人',
    text: '入院・手術の給付金の受取人は、原則として被保険者本人で、請求書も本人が書く。本人が請求できないときに備える指定代理請求は、特約を付けるのが一般的で、契約時だけでなく契約後にも代理人を指定できる。利用条件や対象は保険会社・商品によって異なる。',
    sources: [
      source('オリックス生命', 'https://faq.orixlife.co.jp/faq_detail.html?id=8401599'),
      source('生命保険協会 便利帳（2023 年改訂、p.22-23）', 'https://www.seiho.or.jp/data/publication/elderly/pdf/all.pdf'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F14',
    topic: '医療費控除',
    text: '医療費控除では、病院で出る食事の代金と、通常必要な電車・バスでの通院費は対象になる。本人や家族の都合で入った個室の差額ベッド代、身の回り品、保険請求用の診断書の文書料、タクシー代（公共交通機関が使えない場合を除く）は対象外。保険金や高額療養費の補填額は、その給付の対象になった医療費を限度に差し引く。申告義務のない人の還付申告は翌年 1 月 1 日から 5 年間できるが、期限内の申告が必要な特例もある。',
    sources: [
      source('国税庁 No.1120', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1120.htm'),
      source('国税庁 No.1126', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1126.htm'),
      source('国税庁 No.1122', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/1122.htm'),
      source('東京国税局 文書料の取扱い', 'https://www.nta.go.jp/about/organization/tokyo/bunshokaito/shotoku/141201/01.htm'),
      source('国税庁 No.2030 還付申告', 'https://www.nta.go.jp/taxes/shiraberu/taxanswer/shotoku/2030.htm'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F15',
    topic: '傷病手当金',
    text: '協会けんぽの傷病手当金は、業務外の病気やけがの療養で働けない被保険者が、連続 3 日の待期のあと 4 日目以降も休み、給与を受けられないなどの条件を満たすと対象になる。給与が手当金より少ない場合は差額になる。審査で支払い可能となれば、受付から 10 営業日以内に支払うと案内している。札幌市の国民健康保険の「保険給付」の手続き一覧には傷病手当金の記載が見つからないが、給付の有無は区役所に確認する。額は標準報酬月額などで決まるため、この試作では計算しない。',
    sources: [
      source('全国健康保険協会', 'https://www.kyoukaikenpo.or.jp/benefit/injury_and_sickness_allowance/index.html'),
      source('全国健康保険協会 よくある質問', 'https://www.kyoukaikenpo.or.jp/faq/benefit/002/index.html'),
      source('札幌市 保険給付の手続き一覧', 'https://www.city.sapporo.jp/hoken-iryo/kokuho/hoken_kyufu.html'),
    ],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
  {
    id: 'F16',
    topic: '入院した人の調査の数字（集団の平均）',
    text: '過去 5 年に入院した人への調査では、直近の入院の自己負担費用は平均 18.7 万円（食事代・差額ベッド代・交通費などを含み、高額療養費を使ったあとの額）、入院日数は平均 16.0 日。入院した人のうち、窓口で上限までを払う形で高額療養費を使った人は 49.6%、いったん払って後から払い戻しを受けた人は 17.9%。これは集団の数字で、その人の入院の見通しではない。',
    sources: [source('生命保険文化センター「2025 年度 生活保障に関する調査」', 'https://www.jili.or.jp/files/research/chousa/pdf/r7/2025honshi_all-.pdf')],
    checked_on: '2026-11-06',
    verified: 'primary',
  },
]);

// システムプロンプトに入れる形。出典の URL は画面が持つので、ここでは番号と本文だけにする。
export function factsForPrompt() {
  return FACTS.map((fact) => `[${fact.id}] ${fact.topic}: ${fact.text}`).join('\n');
}
